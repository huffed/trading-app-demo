/**
 * Phase 2.1–2.5, 2.7 — statistical validation of the deployed 5-algo portfolio
 * ($100K, sibling-aware, canonical pins 2015→2026-07-09; the locked window is
 * NOT used). Reuses the repo's own statistics library.
 * Reproduce: pnpm dlx tsx review/scripts/phase2-stats.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { bootstrapStatBlock } from "../../src/lib/stats/bootstrap";
import { computeDeflatedSharpe, kurtosis, skewness } from "../../src/lib/stats/deflated-sharpe";
import type { BacktestTrade } from "../../src/lib/market-data/types";
import { dateIndexOf, loadDeployedMembers, mean, nominalR, quantile, reconstructGeometry, runSiblingAware, sd } from "./lib/harness";
import { CANONICAL_PINS, loadPinnedFile, sessionDaily } from "./lib/pins";

const CAP = 100_000, RISK = 0.42, ITER = 10_000;
type T = BacktestTrade & { algo: string };
const wr = (ts: BacktestTrade[]) => (ts.length ? (100 * ts.filter((t) => t.pnl > 0).length) / ts.length : 0);
const pf = (ts: BacktestTrade[]) => { const w = ts.filter((t) => t.pnl > 0).reduce((a, t) => a + t.pnl, 0); const l = ts.filter((t) => t.pnl < 0).reduce((a, t) => a - t.pnl, 0); return l > 0 ? w / l : Infinity; };
const maxDdPct = (ts: BacktestTrade[], cap: number) => { let cum = 0, peak = 0, mdd = 0; for (const t of [...ts].sort((a, b) => a.exit_date.localeCompare(b.exit_date))) { cum += t.pnl; peak = Math.max(peak, cum); mdd = Math.max(mdd, peak - cum); } return (100 * mdd) / cap; };
const mR = (ts: BacktestTrade[]) => mean(ts.map((t) => nominalR(t, CAP, RISK)));
const normCdf = (x: number) => 0.5 * (1 + erf(x / Math.SQRT2));
function erf(x: number) { const s = Math.sign(x); x = Math.abs(x); const t = 1 / (1 + 0.3275911 * x); const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return s * y; }
function binomCdf(k: number, n: number, p: number) { let s = 0; for (let i = 0; i <= k; i++) { let c = 1; for (let j = 1; j <= i; j++) c = (c * (n - i + j)) / j; s += c * p ** i * (1 - p) ** (n - i); } return s; }

async function main() {
  const h4 = loadPinnedFile(CANONICAL_PINS.h4).bars; const daily = sessionDaily(loadPinnedFile(CANONICAL_PINS.d).bars); const idx = dateIndexOf(h4);
  const members = await loadDeployedMembers(); const rulesByLabel = new Map(members.map((m) => [m.label, m.rules]));
  const run = runSiblingAware(members, h4, daily, CAP, { uniformRisk: RISK });
  const u = ([...run.union] as T[]).sort((a, b) => a.exit_date.localeCompare(b.exit_date) || a.entry_date.localeCompare(b.entry_date));
  const R = u.map((t) => nominalR(t, CAP, RISK));
  const grossR = u.map((t) => { const g = reconstructGeometry(t, rulesByLabel.get(t.algo)!, h4, idx); return g ? (t.exit_price - t.entry_price) / g.slDistance : NaN; });
  const out: Record<string, unknown> = { n: u.length, mean_r: mean(R), sd_r: sd(R), wr: wr(u), pf: pf(u), max_dd_pct: maxDdPct(u, CAP), skew: skewness(R), kurt: kurtosis(R) };
  console.log(`UNION n=${u.length} meanR=${mean(R).toFixed(4)} sdR=${sd(R).toFixed(3)} WR=${wr(u).toFixed(1)}% PF=${pf(u).toFixed(2)} maxDD=${maxDdPct(u, CAP).toFixed(2)}% skew=${skewness(R).toFixed(2)} kurt=${kurtosis(R).toFixed(2)}`);

  // 2.1 walk-forward folds: calendar years (rolling) + anchored cumulative
  console.log("\n2.1 FOLDS (rules fixed → consistency across folds, not out-of-sample; the only OOS is the locked window)");
  console.log("year   n   WR%   meanR    PF   pnl$   maxDD%  | anchored: n  meanR");
  const years: Record<string, unknown>[] = [];
  for (let y = 2015; y <= 2026; y++) {
    const f = u.filter((t) => t.entry_date.startsWith(String(y))); const cum = u.filter((t) => t.entry_date < `${y + 1}`);
    if (!f.length) continue;
    const row = { year: y, n: f.length, wr: wr(f), mean_r: mR(f), pf: pf(f), pnl: f.reduce((a, t) => a + t.pnl, 0), max_dd_pct: maxDdPct(f, CAP), anchored_n: cum.length, anchored_mean_r: mR(cum) };
    years.push(row);
    console.log(`${y}  ${String(f.length).padStart(3)}  ${wr(f).toFixed(1).padStart(5)}  ${mR(f).toFixed(3).padStart(6)}  ${pf(f).toFixed(2).padStart(5)}  ${row.pnl.toFixed(0).padStart(6)}  ${row.max_dd_pct.toFixed(2).padStart(6)}  | ${String(cum.length).padStart(4)}  ${mR(cum).toFixed(3)}`);
  }
  out.folds = years; out.folds_positive_share = years.filter((y) => (y.mean_r as number) > 0).length / years.length;
  console.log(`folds with positive mean R: ${years.filter((y) => (y.mean_r as number) > 0).length}/${years.length}`);

  // 2.2 block-bootstrap CIs (circular moving blocks, block = ceil(sqrt n))
  const ci = (ts: BacktestTrade[], fn: (s: BacktestTrade[]) => number) => bootstrapStatBlock(ts, fn, { n_iterations: ITER, ci_level: 0.95, seed: 42 });
  const cis = { mean_r: ci(u, mR), wr: ci(u, wr), pf: ci(u, pf), max_dd_pct: ci(u, (s) => maxDdPct(s, CAP)) };
  const recent = u.filter((t) => t.entry_date >= "2025-07-01");
  const cisRecent = { mean_r: ci(recent, mR), wr: ci(recent, wr), pf: ci(recent, pf) };
  console.log("\n2.2 BLOCK-BOOTSTRAP 95% CIs (10,000 resamples)");
  for (const [k, v] of Object.entries(cis)) console.log(`  ${k.padEnd(11)} point=${v.point.toFixed(3)}  CI=[${v.lower.toFixed(3)}, ${v.upper.toFixed(3)}]`);
  console.log(`  since 2025-07 (n=${recent.length}): meanR ${cisRecent.mean_r.point.toFixed(3)} [${cisRecent.mean_r.lower.toFixed(3)}, ${cisRecent.mean_r.upper.toFixed(3)}]  WR ${cisRecent.wr.point.toFixed(1)} [${cisRecent.wr.lower.toFixed(1)}, ${cisRecent.wr.upper.toFixed(1)}]  PF ${cisRecent.pf.point.toFixed(2)} [${cisRecent.pf.lower.toFixed(2)}, ${cisRecent.pf.upper.toFixed(2)}]`);
  out.ci = cis; out.ci_recent = cisRecent;

  // 2.3 power
  const z95 = 1.645, z80 = 0.842, z975 = 1.96;
  const nFor = (mu: number, s: number) => Math.ceil(((z95 + z80) * s / mu) ** 2);
  const power = { n_mean_r_gt0_80pct_power: { at_100k_baseline: nFor(mean(R), sd(R)), at_10k_baseline: nFor(0.2551, 1.516) }, n_for_band_80pct_power: Math.ceil(((z975 + z80) * sd(R) / (0.3 * mean(R))) ** 2), p_in_band_if_true_at_n30: 2 * normCdf((0.3 * mean(R)) / (sd(R) / Math.sqrt(30))) - 1, months_at_4_2_per_month: nFor(mean(R), sd(R)) / 4.2, months_at_6_1_per_month: nFor(mean(R), sd(R)) / 6.1 };
  console.log(`\n2.3 POWER: trades for 80% power that mean R > 0 (one-sided 95%): ${power.n_mean_r_gt0_80pct_power.at_100k_baseline} (μ=${mean(R).toFixed(3)}, σ=${sd(R).toFixed(2)}) / ${power.n_mean_r_gt0_80pct_power.at_10k_baseline} (old baseline) → ${power.months_at_4_2_per_month.toFixed(0)} months at the live 4.2 trades/mo, ${power.months_at_6_1_per_month.toFixed(0)} at the backtest 6.1/mo. P(inside ±30% band at n=30 | true mean = baseline) = ${(100 * power.p_in_band_if_true_at_n30).toFixed(0)}%. Trades for the band to have 80% power: ${power.n_for_band_80pct_power}.`);
  out.power = power;

  // 2.4 selection bias — deflated Sharpe over a grid of (N trials, σ_SR)
  const SR = mean(R) / sd(R);
  const dsrGrid: Array<Record<string, number>> = [];
  console.log(`\n2.4 DEFLATED SHARPE (observed per-trade SR=${SR.toFixed(4)}, T=${R.length}, skew=${skewness(R).toFixed(2)}, kurt=${kurtosis(R).toFixed(2)})`);
  console.log("  N trials   σ_SR    E[max SR]   DSR     p(one-sided)");
  for (const nT of [96, 300, 2000, 3300]) for (const sig of [0.044, 0.06, 0.10]) {
    const d = computeDeflatedSharpe({ observedSharpe: SR, returns: R, nTrials: nT, trialSharpeStd: sig });
    dsrGrid.push({ n_trials: nT, sigma_sr: sig, expected_max_sr: d.expectedMaxSharpe, dsr: d.deflatedSharpe, p: d.pValueOneSided });
    console.log(`  ${String(nT).padStart(8)}   ${sig.toFixed(3)}   ${d.expectedMaxSharpe.toFixed(4).padStart(8)}   ${d.deflatedSharpe.toFixed(3)}   ${d.pValueOneSided.toFixed(3)}`);
  }
  // family dispersion actually observed among the five deployed algos (solo per-trade Sharpe)
  const soloSR = members.map((m) => { const rs = run.soloTrades.get(m.label)!.map((t) => nominalR(t, CAP, RISK)); return mean(rs) / sd(rs); });
  console.log(`  observed per-trade Sharpe across the 5 deployed algos: ${soloSR.map((x) => x.toFixed(3)).join(", ")} → sd ${sd(soloSR).toFixed(3)} (ROADMAP cites σ_SR 0.044 within the Engulfing family)`);
  out.dsr = { observed_sr: SR, grid: dsrGrid, solo_sr: soloSR, solo_sr_sd: sd(soloSR) };

  // 2.5 trade independence / clustering
  const lag = (k: number) => { const m = mean(R); let num = 0, den = 0; for (let i = 0; i < R.length; i++) { den += (R[i] - m) ** 2; if (i >= k) num += (R[i] - m) * (R[i - k] - m); } return num / den; };
  const byMonth: Record<string, number> = {}; for (const t of u) { const k = t.exit_date.slice(0, 7); byMonth[k] = (byMonth[k] ?? 0) + t.pnl; }
  const monthPnls = Object.values(byMonth).sort((a, b) => b - a); const total = monthPnls.reduce((a, b) => a + b, 0);
  const top5 = Math.max(1, Math.round(monthPnls.length * 0.05)); const top5Share = monthPnls.slice(0, top5).reduce((a, b) => a + b, 0) / total;
  let maxLoss = 0, cur = 0; for (const t of u) { cur = t.pnl < 0 ? cur + 1 : 0; maxLoss = Math.max(maxLoss, cur); }
  const yearShares = Object.fromEntries(years.map((y) => [y.year as number, ((y.pnl as number) / total)]));
  console.log(`\n2.5 INDEPENDENCE: lag autocorrelation of R: ${[1, 2, 3, 5].map((k) => `ρ${k}=${lag(k).toFixed(3)}`).join(" ")}; top 5% of months (${top5}/${monthPnls.length}) carry ${(100 * top5Share).toFixed(0)}% of total P&L; months with positive P&L ${monthPnls.filter((x) => x > 0).length}/${monthPnls.length}; max consecutive losses ${maxLoss}; P&L share by year: ${Object.entries(yearShares).map(([y, s]) => `${y}:${(100 * s).toFixed(0)}%`).join(" ")}`);
  out.independence = { lag: { 1: lag(1), 2: lag(2), 3: lag(3), 5: lag(5) }, top5pct_months_share: top5Share, months: monthPnls.length, positive_months: monthPnls.filter((x) => x > 0).length, max_consecutive_losses: maxLoss, year_shares: yearShares };

  // 2.7 demo vs backtest: is live (n=14, mean gross R −0.366, 3 wins) inside the noise?
  const live = JSON.parse(readFileSync("review/results/paper-replay.json", "utf-8")) as { live: Array<{ live_gross_r: number | null }> };
  const liveR = live.live.map((l) => l.live_gross_r).filter((x): x is number => typeof x === "number");
  const liveMean = mean(liveR), liveWins = liveR.filter((x) => x > 0).length;
  const g = grossR.filter((x) => Number.isFinite(x));
  const wins14: number[] = []; const means14: number[] = [];
  for (let i = 0; i + 14 <= g.length; i++) { const w = g.slice(i, i + 14); means14.push(mean(w)); wins14.push(w.filter((x) => x > 0).length); }
  const pMean = means14.filter((m) => m <= liveMean).length / means14.length;
  const pBoth = means14.filter((m, i) => m <= liveMean && wins14[i] <= liveWins).length / means14.length;
  const liveCi = bootstrapStatBlock(liveR.map((r) => ({ pnl: r, entry_date: "", exit_date: "", entry_price: 0, exit_price: 0, side: "long" as const })), (s) => mean(s.map((t) => t.pnl)), { n_iterations: ITER, seed: 42, block_size: 1 });
  console.log(`\n2.7 DEMO vs BACKTEST: live n=${liveR.length} mean gross R=${liveMean.toFixed(3)} (bootstrap 95% CI [${liveCi.lower.toFixed(2)}, ${liveCi.upper.toFixed(2)}]), wins=${liveWins}. Over ${means14.length} contiguous 14-trade windows of the backtest (gross R): P(mean ≤ ${liveMean.toFixed(3)}) = ${(100 * pMean).toFixed(1)}%; P(mean ≤ live AND wins ≤ ${liveWins}) = ${(100 * pBoth).toFixed(1)}%; Binomial P(≤${liveWins} wins | n=14, p=${(wr(u) / 100).toFixed(3)}) = ${(100 * binomCdf(liveWins, 14, wr(u) / 100)).toFixed(1)}%. Backtest 14-window mean R: p5=${quantile(means14, 0.05).toFixed(2)} p50=${quantile(means14, 0.5).toFixed(2)} p95=${quantile(means14, 0.95).toFixed(2)}.`);
  out.demo_vs_backtest = { live_n: liveR.length, live_mean_gross_r: liveMean, live_ci: [liveCi.lower, liveCi.upper], live_wins: liveWins, p_window_mean_le_live: pMean, p_window_mean_and_wins_le_live: pBoth, binom_p_wins_le_live: binomCdf(liveWins, 14, wr(u) / 100), window14: { p5: quantile(means14, 0.05), p50: quantile(means14, 0.5), p95: quantile(means14, 0.95) } };

  writeFileSync("review/results/phase2-stats.json", JSON.stringify({ ...out, generated_at: new Date().toISOString() }, null, 1));
  console.log("\n→ review/results/phase2-stats.json");
}
main().catch((e) => { console.error(e); process.exit(1); });
