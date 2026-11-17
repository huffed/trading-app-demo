/**
 * Phase 3 — regime analysis, starting from 01-audit A18 and 02-validation §2.1/§2.5.
 *
 * Corpus: canonical pins 2015-01-01 → 2026-07-09 (the selection corpus). The locked
 * window (2026-07-10 → 10-28) is NOT evaluated by any strategy run here; the only use
 * of the 2026-10-28 refresh is to DESCRIBE the market (bias-run lengths), not to score
 * a rule. Portfolio runs are sibling-aware at $100K / 0.42% uniform risk (the Phase 2
 * population). Sets:
 *   L_on  = the five deployed rules (long, daily_bias bullish)         — the baseline
 *   L_off = the same five with the daily_bias condition removed
 *   S_on  = the five mirrored short (side short, pattern + bias bearish)
 *   S_off = the mirror without the bias condition
 *   LS_on = L_on + S_on run together (10 members; direction-conflict gating applies)
 * Outputs: review/results/phase3-regime.json (tables) and phase3-trades.csv (every trade,
 * annotated with the SMA20 bias and the age of the bias run at entry).
 * Reproduce: pnpm exec tsx review/scripts/phase3-regime.ts  (≈5 min)
 */
import { writeFileSync } from "node:fs";
import { loadDeployedMembers, runSiblingAware, type Member } from "./lib/harness";
import {
  CAP,
  RISK,
  brief,
  maxDdPct,
  meanR,
  mirrored,
  pnl,
  r2,
  r3,
  rOf,
  say,
  sumR,
  withoutBias,
  type Brief,
  type Trade,
} from "./lib/phase3-lib";
import { biasRuns, runPositions, sessIdxAt, sessions } from "./lib/phase3-market";
import { quarters, years, type Period } from "./lib/phase3-regime-vars";
import { describe2026, regimeSections, runSections } from "./lib/phase3-sections";
import {
  biasSections,
  fmtRow,
  periodStats,
  type Annot,
  type PeriodStats,
  type Unions,
} from "./lib/phase3-tables";
import { CANONICAL_PINS, loadPinnedFile, sessionDaily } from "./lib/pins";
import type { PriceBar } from "../../src/lib/market-data/types";

const OUT = "review/results/phase3-regime.json";
const OUT_TRADES = "review/results/phase3-trades.csv";

function buildSets(deployed: Member[]): Record<string, Member[]> {
  const sets: Record<string, Member[]> = {
    L_on: deployed,
    L_off: deployed.map((m) => ({ label: m.label, rules: withoutBias(m.rules) })),
    S_on: deployed.map((m) => ({ label: `${m.label} SHORT`, rules: mirrored(m.rules, true) })),
    S_off: deployed.map((m) => ({ label: `${m.label} SHORT`, rules: mirrored(m.rules, false) })),
  };
  sets.LS_on = [...sets.L_on, ...sets.S_on];
  return sets;
}
function runSets(
  sets: Record<string, Member[]>,
  h4: PriceBar[],
  daily: PriceBar[]
): {
  unions: Unions;
  perMember: Record<string, unknown>;
  perMemberStats: Record<string, Record<string, Brief>>;
} {
  const unions: Unions = {},
    perMember: Record<string, unknown> = {},
    perMemberStats: Record<string, Record<string, Brief>> = {};
  for (const [name, members] of Object.entries(sets)) {
    const t0 = Date.now();
    const run = runSiblingAware(members, h4, daily, CAP, { uniformRisk: RISK });
    const u = (run.union as Trade[]).sort((a, b) => a.entry_date.localeCompare(b.entry_date));
    unions[name] = u;
    perMember[name] = run.perMember;
    perMemberStats[name] = {};
    for (const m of members) {
      perMemberStats[name][m.label] = brief(u.filter((t) => t.algo === m.label));
    }
    const solo = run.perMember
      .map((p) => `${p.label.replace(" SHORT", "s")}=${String(p.solo)}/${String(p.aware)}`)
      .join(" ");
    say(
      `[${name}] members=${String(members.length)} union n=${String(u.length)} meanR=${meanR(u).toFixed(3)} sumR=${sumR(u).toFixed(1)} pnl=$${pnl(u).toFixed(0)} maxDD=${maxDdPct(u).toFixed(1)}%  (${((Date.now() - t0) / 1000).toFixed(0)}s)  solo/aware: ${solo}`
    );
    for (const [label, b] of Object.entries(perMemberStats[name])) {
      say(
        `    ${label.padEnd(30)} n=${String(b.n).padStart(4)} meanR=${b.mean_r.toFixed(3).padStart(7)} sumR=${b.sum_r.toFixed(1).padStart(7)} WR=${b.wr.toFixed(1)}% pnl=$${String(b.pnl)}`
      );
    }
  }
  return { unions, perMember, perMemberStats };
}
function yearTables(
  unions: Unions,
  yrs: Period[],
  first: string,
  last: string
): Record<string, Record<string, PeriodStats>> {
  const yearly: Record<string, Record<string, PeriodStats>> = {};
  for (const [name, u] of Object.entries(unions)) {
    yearly[name] = {};
    say(`\n== ${name} by entry year ==`);
    for (const p of yrs) {
      yearly[name][p.key] = periodStats(u, p.from, p.to);
      say(fmtRow(p.key, yearly[name][p.key]));
    }
    yearly[name].ALL = periodStats(u, first, last);
    say(fmtRow("ALL", yearly[name].ALL));
  }
  return yearly;
}
function writeTrades(unions: Unions, annot: Annot): number {
  const header =
    "set,algo,side,entry_date,exit_date,entry_price,exit_price,pnl,r_nominal,exit_reason,bias_at_entry,run_age_at_entry,run_total_hindsight";
  const lines = Object.entries(unions).flatMap(([set, ts]) =>
    ts.map((t) => {
      const a = annot(t);
      return [
        set,
        t.algo,
        t.side,
        t.entry_date,
        t.exit_date,
        r2(t.entry_price),
        r2(t.exit_price),
        r2(t.pnl),
        r3(rOf(t)),
        t.exit_reason ?? "",
        a.bias,
        a.age,
        a.total,
      ].join(",");
    })
  );
  writeFileSync(OUT_TRADES, `${[header, ...lines].join("\n")}\n`);
  return lines.length;
}

async function main(): Promise<void> {
  const h4 = loadPinnedFile(CANONICAL_PINS.h4).bars,
    dStart = loadPinnedFile(CANONICAL_PINS.d).bars,
    daily = sessionDaily(dStart);
  const first = h4[0].date,
    last = h4[h4.length - 1].date;
  const sets = buildSets(await loadDeployedMembers());
  const { unions, perMember, perMemberStats } = runSets(sets, h4, daily);
  const yrs = years(first, last);
  const yearly = yearTables(unions, yrs, first, last);
  const sess = sessions(daily),
    runs = biasRuns(sess),
    pos = runPositions(sess, runs);
  const annot: Annot = (t) => {
    const i = sessIdxAt(sess, t.entry_date);
    return i < 0 ? { bias: "neutral", age: 0, total: 0 } : pos[i];
  };
  const { split, ageTables } = biasSections(unions, annot);
  const { runRows, runAgg, outside, afterBear, biasShare } = runSections(unions, sess, runs);
  const regime = regimeSections(sess, { yrs, qs: quarters(first, last) }, yearly.L_on, unions.L_on);
  const runsR = describe2026(dStart);
  const longestBearish = runs
    .filter((r) => r.bias === "bearish")
    .sort((a, b) => b.sessions - a.sessions)
    .slice(0, 10);
  const setsOut = Object.fromEntries(
    Object.entries(sets).map(([k, v]) => [
      k,
      v.map((m) => ({
        label: m.label,
        side: m.rules.side,
        entry_conditions: m.rules.entry_conditions,
      })),
    ])
  );
  const totals = Object.fromEntries(Object.keys(unions).map((k) => [k, yearly[k].ALL]));
  const out = {
    generated_at: new Date().toISOString(),
    corpus: { first, last, h4_bars: h4.length, sessions: sess.length },
    capital: CAP,
    risk: RISK,
    sets: setsOut,
    per_member: perMember,
    per_member_stats: perMemberStats,
    totals,
    yearly,
    bias_split: split,
    age_tables: ageTables,
    bias_share: biasShare,
    bias_runs_ge15: runRows,
    bias_runs_agg: runAgg,
    outside_runs_ge15: outside,
    l_on_after_bearish_runs_40_sessions: afterBear,
    longest_bearish_runs: longestBearish,
    ...regime,
    runs_2026_refresh_description: runsR,
  };
  writeFileSync(OUT, JSON.stringify(out, null, 1));
  const n = writeTrades(unions, annot);
  say(`\n→ ${OUT}\n→ ${OUT_TRADES} (${String(n)} trades)`);
}
main().catch((e: unknown) => {
  process.stderr.write(`${String(e)}\n`);
  process.exit(1);
});
