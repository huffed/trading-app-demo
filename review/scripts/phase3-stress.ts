/**
 * Phase 3 — the DD / max-loss side of the bias and direction questions (01-audit A15:
 * "the filter's contribution needs a DD/ML check, not a mean-R one").
 * Runs the Phase 3 sets (L_on, L_off, S_on, LS_on) sibling-aware through the engine at
 * $100K/0.42% (the paper sizing) and $50K/0.30% (the Phase 2 recommendation), then the
 * Phase 2.6 challenge simulators from scripts/canonical/lib/pinned-eval:
 *   runUntilTarget (Phase 1 +10% / Phase 2 +5%, static −10% floor, −5% daily),
 *   stressTest (worst 60-day window), mcChallenge (10,000 block-resampled challenges).
 * Also the worst 60-day max loss per calendar year for L_on, L_off and LS_on at $100K.
 * Corpus: canonical pins 2015-01-01 → 2026-07-09; the locked window is not used.
 * Reproduce: pnpm exec tsx review/scripts/phase3-stress.ts  (≈8 min)
 */
import { writeFileSync } from "node:fs";
import {
  buildDailyPath,
  mcChallenge,
  runUntilTarget,
  stressTest,
} from "../../scripts/canonical/lib/pinned-eval";
import { loadDeployedMembers, mean, runSiblingAware, type Member } from "./lib/harness";
import { mirrored, r2, rOf, say, withoutBias } from "./lib/phase3-lib";
import { CANONICAL_PINS, loadPinnedFile, sessionDaily } from "./lib/pins";
import type { BacktestTrade, PriceBar } from "../../src/lib/market-data/types";

const SIZINGS: { cap: number; risk: number }[] = [
  { cap: 100_000, risk: 0.42 },
  { cap: 50_000, risk: 0.3 },
];
const YEARLY_SETS = new Set(["L_on", "L_off", "LS_on"]);
interface Row {
  set: string;
  capital: number;
  risk: number;
  n: number;
  mean_r: number;
  p1_pass_pct: number;
  p1_median_months: number;
  p2_pass_pct: number;
  p2_median_months: number;
  p_funded_pct: number;
  stress_windows: number;
  stress_fail_ml: number;
  stress_fail_dl: number;
  stress_worst_ml: number;
  stress_worst_dl: number;
  mc_p_ml_gt5: number;
  mc_p_ml_gt8: number;
  mc_p_ml_gt10: number;
  mc_ml_p95: number;
}
interface YearStress {
  windows: number;
  fail_ml: number;
  worst_ml: number;
  worst_dl: number;
}
interface Bars {
  h4: PriceBar[];
  daily: PriceBar[];
}

function simulate(
  name: string,
  members: Member[],
  sizing: { cap: number; risk: number },
  bars: Bars
): { row: Row; u: BacktestTrade[] } {
  const { cap, risk } = sizing;
  const u = runSiblingAware(members, bars.h4, bars.daily, cap, { uniformRisk: risk }).union;
  const p1 = runUntilTarget(u, cap, 10, 10, 5),
    p2 = runUntilTarget(u, cap, 5, 10, 5);
  const st = stressTest(u, cap);
  const mc = mcChallenge(buildDailyPath(u, cap), 10_000, 21, 10, 10, 5);
  const row: Row = {
    set: name,
    capital: cap,
    risk,
    n: u.length,
    mean_r: r2(mean(u.map((t) => rOf(t, cap, risk)))),
    p1_pass_pct: r2(p1.pass_rate_pct),
    p1_median_months: r2(p1.median_months),
    p2_pass_pct: r2(p2.pass_rate_pct),
    p2_median_months: r2(p2.median_months),
    p_funded_pct: r2((p1.pass_rate_pct / 100) * p2.pass_rate_pct),
    stress_windows: st.windows,
    stress_fail_ml: st.fail_ml,
    stress_fail_dl: st.fail_dl,
    stress_worst_ml: r2(st.worst_ml),
    stress_worst_dl: r2(st.worst_dl),
    mc_p_ml_gt5: r2(mc.p_ml_gt(5)),
    mc_p_ml_gt8: r2(mc.p_ml_gt(8)),
    mc_p_ml_gt10: r2(mc.p_ml_gt(10)),
    mc_ml_p95: r2(mc.ml_p95),
  };
  return { row, u };
}
function fmtRow(r: Row, seconds: number): string {
  const f = (x: number, w: number, d = 1): string => x.toFixed(d).padStart(w);
  return `${r.set.padEnd(7)} ${String(r.capital).padStart(7)} ${r.risk.toFixed(2)} ${String(r.n).padStart(5)} ${f(r.mean_r, 6, 3)} | ${f(r.p1_pass_pct, 6)} ${f(r.p1_median_months, 6)} | ${f(r.p2_pass_pct, 6)} ${f(r.p2_median_months, 6)} | ${f(r.p_funded_pct, 6)} | ${f(r.stress_worst_ml, 6, 2)} ${f(r.stress_worst_dl, 6, 2)} ${String(r.stress_fail_ml + r.stress_fail_dl).padStart(3)}/${String(r.stress_windows)} | ${f(r.mc_p_ml_gt5, 5)} ${f(r.mc_p_ml_gt8, 5)} ${f(r.mc_p_ml_gt10, 5)} ${r.mc_ml_p95.toFixed(2)}  (${String(seconds)}s)`;
}
function yearlyStress(name: string, u: BacktestTrade[], cap: number): Record<string, YearStress> {
  const out: Record<string, YearStress> = {};
  for (let y = 2015; y <= 2026; y++) {
    const f = u.filter((t) => t.entry_date.startsWith(String(y)));
    if (!f.length) continue;
    const s = stressTest(f, cap);
    out[String(y)] = {
      windows: s.windows,
      fail_ml: s.fail_ml,
      worst_ml: r2(s.worst_ml),
      worst_dl: r2(s.worst_dl),
    };
  }
  say(
    `    ${name} worst 60-day ML by year: ${Object.entries(out)
      .map(
        ([y, v]) =>
          `${y}:${v.worst_ml.toFixed(1)}%${v.fail_ml ? `(${String(v.fail_ml)} breach)` : ""}`
      )
      .join(" ")}`
  );
  return out;
}

async function main(): Promise<void> {
  const bars: Bars = {
    h4: loadPinnedFile(CANONICAL_PINS.h4).bars,
    daily: sessionDaily(loadPinnedFile(CANONICAL_PINS.d).bars),
  };
  const deployed = await loadDeployedMembers();
  const sets: Record<string, Member[]> = {
    L_on: deployed,
    L_off: deployed.map((m) => ({ label: m.label, rules: withoutBias(m.rules) })),
    S_on: deployed.map((m) => ({ label: `${m.label} SHORT`, rules: mirrored(m.rules, true) })),
  };
  sets.LS_on = [...sets.L_on, ...sets.S_on];
  const rows: Row[] = [];
  const yearly: Record<string, Record<string, YearStress>> = {};
  say(
    "set     capital risk%    n  meanR | P1 pass% med.mo | P2 pass% med.mo | funded% | stress worstML worstDL breach/windows | MC P(ML>5) P(ML>8) P(ML>10) ml_p95"
  );
  for (const [name, members] of Object.entries(sets)) {
    for (const sizing of SIZINGS) {
      const t0 = Date.now();
      const { row, u } = simulate(name, members, sizing, bars);
      rows.push(row);
      say(fmtRow(row, Math.round((Date.now() - t0) / 1000)));
      if (sizing.cap === 100_000 && YEARLY_SETS.has(name)) {
        yearly[name] = yearlyStress(name, u, sizing.cap);
      }
    }
  }
  writeFileSync(
    "review/results/phase3-stress.json",
    JSON.stringify(
      { generated_at: new Date().toISOString(), rows, worst_60d_ml_by_year: yearly },
      null,
      1
    )
  );
  say("→ review/results/phase3-stress.json");
}
main().catch((e: unknown) => {
  process.stderr.write(`${String(e)}\n`);
  process.exit(1);
});
