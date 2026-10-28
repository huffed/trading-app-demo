/**
 * Phase 1/2 — the G.8 baseline two ways (operator addition #1).
 * Re-runs the deploy harness's sibling-aware portfolio on the canonical pinned
 * H4 (2015→2026-07-09) at three pool capitals: $10K (the harness, 0.01-lot
 * floor binding), $100K (paper capital), $1M (floor negligible ≈ paper's
 * no-floor sizing). Two member sets: the DEPLOYED rows' rules (what paper
 * runs) and the harness's SOURCE rows (what produced g8-baseline.json).
 * Also derives the stop-width distribution → smallest account where the
 * 0.01-lot floor skips < 5% of signals at 0.42% risk.
 * Reproduce: pnpm dlx tsx review/scripts/baseline-two-ways.ts
 */
import { writeFileSync } from "node:fs";
import {
  dateIndexOf,
  loadDeployedMembers,
  loadHarnessSourceMembers,
  mean,
  nominalR,
  quantile,
  reconstructGeometry,
  runSiblingAware,
  sd,
  type Member,
} from "./lib/harness";
import { CANONICAL_PINS, loadPinnedFile, sessionDaily } from "./lib/pins";
import type { BacktestTrade } from "../../src/lib/market-data/types";

const RISK = 0.42;
const CAPITALS = [10_000, 100_000, 1_000_000];

function summarize(trades: BacktestTrade[], capital: number) {
  const rs = trades.map((t) => nominalR(t, capital, RISK));
  const wins = trades.filter((t) => t.pnl > 0).length;
  return { n: trades.length, mean_r: mean(rs), sd_r: sd(rs), wr_pct: trades.length ? (100 * wins) / trades.length : 0, sum_pnl: trades.reduce((a, t) => a + t.pnl, 0) };
}
const key = (t: BacktestTrade & { algo?: string }): string => `${t.algo ?? "?"}|${t.entry_date}`;

function diffRules(a: unknown, b: unknown, path = ""): string[] {
  const out: string[] = [];
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    if (JSON.stringify(a) !== JSON.stringify(b)) out.push(`${path}: ${JSON.stringify(a)} → ${JSON.stringify(b)}`);
    return out;
  }
  const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
  for (const k of keys) out.push(...diffRules((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], path ? `${path}.${k}` : k));
  return out;
}

async function main() {
  const h4 = loadPinnedFile(CANONICAL_PINS.h4);
  const d = loadPinnedFile(CANONICAL_PINS.d);
  const daily = sessionDaily(d.bars);
  const bars = h4.bars;
  const idx = dateIndexOf(bars);
  console.log(`pinned H4 ${bars.length} bars (${h4.manifest.sha256.slice(0, 12)}…), session dailies ${daily.length}`);

  const sets: Record<string, Member[]> = {
    deployed: await loadDeployedMembers(),
    harness_source: await loadHarnessSourceMembers(),
  };
  // Rules diff deployed vs harness-source (ignoring the live-only overlays the harness never models)
  console.log("\n== deployed rules vs harness source rules (per member) ==");
  const ignore = new Set(["news_veto", "time_filter", "leverage", "capital"]);
  const rulesDiff: Record<string, string[]> = {};
  for (let i = 0; i < 5; i++) {
    const a = { ...sets.deployed[i].rules } as Record<string, unknown>;
    const b = { ...sets.harness_source[i].rules } as Record<string, unknown>;
    for (const k of ignore) { delete a[k]; delete b[k]; }
    const diffs = diffRules(a, b);
    rulesDiff[sets.deployed[i].label] = diffs;
    console.log(`  ${sets.deployed[i].label}: ${diffs.length === 0 ? "IDENTICAL (excluding news_veto/time_filter/leverage/capital)" : diffs.join("; ")}`);
  }

  const results: Record<string, Record<string, unknown>> = {};
  const unionByCap: Record<string, Record<number, Array<BacktestTrade & { algo?: string }>>> = {};
  for (const [setName, members] of Object.entries(sets)) {
    unionByCap[setName] = {};
    for (const cap of CAPITALS) {
      const t0 = Date.now();
      const r = runSiblingAware(members, bars, daily, cap, { uniformRisk: RISK });
      unionByCap[setName][cap] = r.union as Array<BacktestTrade & { algo?: string }>;
      const port = summarize(r.union, cap);
      const perAlgo = members.map((m) => ({ label: m.label, solo: summarize(r.soloTrades.get(m.label)!, cap), aware_n: r.awareTrades.get(m.label)!.length }));
      results[`${setName}@${cap}`] = { portfolio: port, per_algo: perAlgo, ms: Date.now() - t0 };
      console.log(`\n== ${setName} @ $${cap.toLocaleString()} (${Date.now() - t0} ms) ==`);
      console.log(`  PORTFOLIO (sibling-aware): n=${port.n} meanR=${port.mean_r.toFixed(4)} sdR=${port.sd_r.toFixed(3)} WR=${port.wr_pct.toFixed(1)}% pnl=$${port.sum_pnl.toFixed(0)}`);
      for (const p of perAlgo) console.log(`  ${p.label.padEnd(24)} solo n=${String(p.solo.n).padStart(4)} meanR=${p.solo.mean_r.toFixed(4)} WR=${p.solo.wr_pct.toFixed(1)}%  aware n=${p.aware_n}`);
    }
  }

  // Skipped-by-floor analysis: $1M vs $10K, harness-source set (the baseline's own population)
  for (const setName of Object.keys(sets)) {
    const u10 = new Map(unionByCap[setName][10_000].map((t) => [key(t), t]));
    const u1m = new Map(unionByCap[setName][1_000_000].map((t) => [key(t), t]));
    const onlyBig = [...u1m.entries()].filter(([k]) => !u10.has(k)).map(([, t]) => t);
    const onlySmall = [...u10.entries()].filter(([k]) => !u1m.has(k)).map(([, t]) => t);
    const matched = [...u1m.entries()].filter(([k]) => u10.has(k)).map(([k, t]) => ({ big: t, small: u10.get(k)! }));
    const ratios = matched.map((m) => (m.big.pnl !== 0 ? m.small.pnl / (m.big.pnl / 100) : 1));
    const bigR = onlyBig.map((t) => nominalR(t, 1_000_000, RISK));
    const byYear: Record<string, { big: number; skipped: number }> = {};
    for (const t of u1m.values()) { const y = t.entry_date.slice(0, 4); byYear[y] = byYear[y] ?? { big: 0, skipped: 0 }; byYear[y].big++; }
    for (const t of onlyBig) { const y = t.entry_date.slice(0, 4); byYear[y].skipped++; }
    results[`${setName}:floor_effect`] = {
      trades_at_1M: u1m.size, trades_at_10K: u10.size, present_only_at_1M: onlyBig.length, present_only_at_10K: onlySmall.length,
      mean_r_of_trades_missing_at_10K: mean(bigR), wr_of_trades_missing_at_10K: onlyBig.length ? (100 * onlyBig.filter((t) => t.pnl > 0).length) / onlyBig.length : null,
      pnl_ratio_small_vs_big_scaled: { p10: quantile(ratios, 0.1), p50: quantile(ratios, 0.5), p90: quantile(ratios, 0.9), mean: mean(ratios) },
      by_year: byYear,
    };
    console.log(`\n== ${setName}: lot-floor effect ($1M vs $10K) ==`);
    console.log(`  trades @1M=${u1m.size}  @10K=${u10.size}  present only @1M (skipped/censored at $10K)=${onlyBig.length} (meanR of those ${mean(bigR).toFixed(3)})  present only @10K=${onlySmall.length}`);
    console.log(`  matched-trade pnl ratio (10K pnl ÷ 1M pnl/100): p10=${quantile(ratios, 0.1).toFixed(3)} p50=${quantile(ratios, 0.5).toFixed(3)} p90=${quantile(ratios, 0.9).toFixed(3)} (1.00 = no rounding effect)`);
    console.log(`  by year (trades@1M / skipped@10K): ${Object.entries(byYear).map(([y, v]) => `${y}:${v.big}/${v.skipped}`).join("  ")}`);
  }

  // Stop-width distribution from the $1M deployed solo trades → account-size question
  const dep = sets.deployed;
  const r1m = runSiblingAware(dep, bars, daily, 1_000_000, { uniformRisk: RISK });
  const slds: Array<{ date: string; sld: number; algo: string }> = [];
  for (const m of dep) for (const t of r1m.soloTrades.get(m.label)!) {
    const g = reconstructGeometry(t, m.rules, bars, idx);
    if (g) slds.push({ date: t.entry_date, sld: g.slDistance, algo: m.label });
  }
  const all = slds.map((x) => x.sld);
  const recent = slds.filter((x) => x.date >= "2025-07-01").map((x) => x.sld);
  const threshCap = (s: number) => s / (RISK / 100); // capital below which 0.42% risk sizes to < 1 oz (= < 0.01 lot)
  const capFor = (xs: number[], q: number) => threshCap(quantile(xs, q));
  const skipFrac = (xs: number[], cap: number) => xs.filter((s) => threshCap(s) > cap).length / xs.length;
  const sizing = {
    n_signals_all: all.length, n_signals_since_2025_07: recent.length,
    sld_quantiles_all: { p50: quantile(all, 0.5), p90: quantile(all, 0.9), p95: quantile(all, 0.95) },
    sld_quantiles_recent: { p50: quantile(recent, 0.5), p90: quantile(recent, 0.9), p95: quantile(recent, 0.95) },
    capital_for_lt5pct_skipped_all: capFor(all, 0.95), capital_for_lt5pct_skipped_recent: capFor(recent, 0.95),
    skip_frac_at_10K: { all: skipFrac(all, 10_000), recent: skipFrac(recent, 10_000) },
    skip_frac_at_25K: { all: skipFrac(all, 25_000), recent: skipFrac(recent, 25_000) },
    skip_frac_at_50K: { all: skipFrac(all, 50_000), recent: skipFrac(recent, 50_000) },
    skip_frac_at_100K: { all: skipFrac(all, 100_000), recent: skipFrac(recent, 100_000) },
  };
  console.log(`\n== stop-width distribution (deployed rules, $1M solo signals, n=${all.length}; since 2025-07: n=${recent.length}) ==`);
  console.log(`  SLd $/oz all: p50=${sizing.sld_quantiles_all.p50.toFixed(1)} p90=${sizing.sld_quantiles_all.p90.toFixed(1)} p95=${sizing.sld_quantiles_all.p95.toFixed(1)}`);
  console.log(`  SLd $/oz since 2025-07: p50=${sizing.sld_quantiles_recent.p50.toFixed(1)} p90=${sizing.sld_quantiles_recent.p90.toFixed(1)} p95=${sizing.sld_quantiles_recent.p95.toFixed(1)}`);
  console.log(`  smallest account with <5% of signals skipped by the 0.01-lot floor @0.42%: all-years $${sizing.capital_for_lt5pct_skipped_all.toFixed(0)}, since 2025-07 $${sizing.capital_for_lt5pct_skipped_recent.toFixed(0)}`);
  console.log(`  skip fraction @ $10K: all ${(100 * sizing.skip_frac_at_10K.all).toFixed(1)}% / recent ${(100 * sizing.skip_frac_at_10K.recent).toFixed(1)}%;  @ $25K: ${(100 * sizing.skip_frac_at_25K.all).toFixed(1)}% / ${(100 * sizing.skip_frac_at_25K.recent).toFixed(1)}%;  @ $50K: ${(100 * sizing.skip_frac_at_50K.all).toFixed(1)}% / ${(100 * sizing.skip_frac_at_50K.recent).toFixed(1)}%;  @ $100K: ${(100 * sizing.skip_frac_at_100K.all).toFixed(1)}% / ${(100 * sizing.skip_frac_at_100K.recent).toFixed(1)}%`);
  results.sizing = sizing;
  results.rules_diff = rulesDiff;
  results.meta = { pinned_h4_sha256: h4.manifest.sha256, pinned_d_sha256: d.manifest.sha256, risk_pct: RISK, generated_at: new Date().toISOString() };
  writeFileSync("review/results/baseline-two-ways.json", JSON.stringify(results, null, 1));
  console.log("\n→ review/results/baseline-two-ways.json");
}
main().catch((e) => { console.error(e); process.exit(1); });
