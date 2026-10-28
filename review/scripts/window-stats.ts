/**
 * Locked-window pre-registration inputs: for the deployed portfolio ($100K,
 * sibling-aware, pinned 2015→2026-07-09), the distribution over rolling
 * 110-day windows (= the length of the locked 2026-07-10→10-28 window) of
 * trade count and of the sign of mean R. Reproduce: pnpm dlx tsx review/scripts/window-stats.ts
 */
import { writeFileSync } from "node:fs";
import { loadDeployedMembers, mean, nominalR, quantile, runSiblingAware } from "./lib/harness";
import { CANONICAL_PINS, loadPinnedFile, sessionDaily } from "./lib/pins";
const CAP = 100_000, RISK = 0.42, WIN_DAYS = 110, STEP_DAYS = 7;
(async () => {
  const h4 = loadPinnedFile(CANONICAL_PINS.h4).bars; const daily = sessionDaily(loadPinnedFile(CANONICAL_PINS.d).bars);
  const run = runSiblingAware(await loadDeployedMembers(), h4, daily, CAP, { uniformRisk: RISK });
  const trades = run.union.map((t) => ({ ms: Date.parse(t.entry_date), r: nominalR(t, CAP, RISK) })).sort((a, b) => a.ms - b.ms);
  const first = trades[0].ms, last = trades[trades.length - 1].ms;
  const counts: number[] = [], means: number[] = [];
  for (let s = first; s + WIN_DAYS * 86_400_000 <= last; s += STEP_DAYS * 86_400_000) {
    const w = trades.filter((t) => t.ms >= s && t.ms < s + WIN_DAYS * 86_400_000);
    counts.push(w.length); if (w.length) means.push(mean(w.map((t) => t.r)));
  }
  const out = { windows: counts.length, trade_count: { p5: quantile(counts, 0.05), p25: quantile(counts, 0.25), p50: quantile(counts, 0.5), p75: quantile(counts, 0.75), p95: quantile(counts, 0.95), min: Math.min(...counts), max: Math.max(...counts) }, mean_r_positive_share: means.filter((m) => m > 0).length / means.length, mean_r: { p5: quantile(means, 0.05), p50: quantile(means, 0.5), p95: quantile(means, 0.95) }, recent_2025_07_on: { windows: 0, trade_count_p50: 0 } };
  const rec = trades.filter((t) => t.ms >= Date.parse("2025-07-01"));
  const rc: number[] = []; for (let s = Date.parse("2025-07-01"); s + WIN_DAYS * 86_400_000 <= last; s += STEP_DAYS * 86_400_000) rc.push(rec.filter((t) => t.ms >= s && t.ms < s + WIN_DAYS * 86_400_000).length);
  out.recent_2025_07_on = { windows: rc.length, trade_count_p50: quantile(rc, 0.5) };
  console.log(JSON.stringify(out, null, 1));
  writeFileSync("review/results/window-stats.json", JSON.stringify({ ...out, win_days: WIN_DAYS, step_days: STEP_DAYS, capital: CAP, risk: RISK }, null, 1));
})();
