/**
 * Phase 1.1 — daily_bias alignment: live vs backtest. Three alignments of the
 * NY-session daily series to a 4h bar:
 *   LIVE     = last session whose CLOSE ≤ the 4h bar's close (what the scan
 *              sees: completed sessions only, acted on after the bar closes)
 *   INTENDED = last session whose close ≤ the 4h bar's START (what the engine
 *              would do if `higherTfCloseStamped` reached the evaluator)
 *   CURRENT  = last close-stamped session whose UTC date-prefix < the bar's
 *              date-prefix (what the engine actually does because the flag is
 *              dropped at condition-evaluator.ts:134-141)
 * Reports how often the SMA20 bias differs between them, on all bars and on
 * bars where a deployed pattern fires. Reproduce: pnpm dlx tsx review/scripts/bias-alignment.ts
 */
import { writeFileSync } from "node:fs";
import { detectAsianRangeBreak } from "../../src/lib/patterns/asian-range-break";
import { detectDailyBias } from "../../src/lib/patterns/daily-bias";
import { detectEngulfing } from "../../src/lib/patterns/engulfing";
import { detectOutsideBar } from "../../src/lib/patterns/outside-bar";
import { alignBarIndex, alignCompletedDailyIndex } from "../../src/lib/market-data/resample";
import { CANONICAL_PINS, loadPinnedFile, sessionDaily } from "./lib/pins";
import { computeSlDistance } from "../../src/lib/algorithm/structural-sl";
import { checkAtrLiquidity } from "../../src/lib/algorithm/intraday-atr-gate";
import { loadDeployedMembers } from "./lib/harness";
import type { PriceBar } from "../../src/lib/market-data/types";

const H4_MS = 4 * 3600_000;
function biasAt(daily: PriceBar[], dIdx: number): "bullish" | "bearish" | "none" {
  if (dIdx < 0) return "none";
  const r = detectDailyBias(daily.slice(0, dIdx + 1), 20);
  return r.detected && r.details ? (r.details.bias as "bullish" | "bearish") : "none";
}
/** Minimal replay of one signal with the engine's geometry + exit rule
 *  (gap-open → fill at open, stop wins ties, TP at level); gross R. */
function simulate(h4: PriceBar[], i: number, rules: { stop_loss: { type: string; value: number; lookback?: number }; take_profit: { type: string; value: number } }): number | null {
  const entry = h4[i].close * (1 + 0.5e-4);
  const sld = computeSlDistance(rules.stop_loss as never, "long", entry, "XAU/USD", h4, i);
  if (!(sld > 0)) return null;
  const rr = rules.take_profit.type === "rr_multiple" ? rules.take_profit.value : 3;
  const sl = entry - sld, tp = entry + Math.max(rr * sld, sld);
  for (let j = i + 1; j < h4.length; j++) {
    const b = h4[j];
    if (b.open <= sl) return (b.open - entry) / sld;
    if (b.low <= sl) return -1;
    if (b.high >= tp) return (tp - entry) / sld;
  }
  return null;
}

async function main() {
  const members = await loadDeployedMembers();
  const byPattern: Record<string, typeof members> = {};
  for (const m of members) {
    const pat = (m.rules.entry_conditions.find((c) => (c as { pattern?: string }).pattern !== "daily_bias") as { pattern?: string } | undefined)?.pattern ?? "?";
    (byPattern[pat] = byPattern[pat] ?? []).push(m);
  }
  const liveOnly: Array<{ r: number; algo: string; date: string }> = [], btOnly: Array<{ r: number; algo: string; date: string }> = [];
  const h4 = loadPinnedFile(CANONICAL_PINS.h4).bars;
  const closeStamped = sessionDaily(loadPinnedFile(CANONICAL_PINS.d).bars);
  const counts = { bars: 0, live_vs_current_diff: 0, live_vs_intended_diff: 0, current_vs_intended_diff: 0, sig: 0, sig_live_vs_current_diff: 0, sig_live_bull_current_bear: 0, sig_live_bear_current_bull: 0, byHour: {} as Record<number, { bars: number; diff: number }> };
  const examples: string[] = [];
  for (let i = 200; i < h4.length; i++) {
    const bar = h4[i];
    const barClose = new Date(Date.parse(bar.date) + H4_MS).toISOString();
    const live = biasAt(closeStamped, alignBarIndex(closeStamped, barClose));
    const intended = biasAt(closeStamped, alignBarIndex(closeStamped, bar.date));
    const current = biasAt(closeStamped, alignCompletedDailyIndex(closeStamped, bar.date));
    counts.bars++;
    const h = new Date(bar.date).getUTCHours();
    counts.byHour[h] = counts.byHour[h] ?? { bars: 0, diff: 0 };
    counts.byHour[h].bars++;
    if (live !== current) { counts.live_vs_current_diff++; counts.byHour[h].diff++; }
    if (live !== intended) counts.live_vs_intended_diff++;
    if (current !== intended) counts.current_vs_intended_diff++;
    const sig = detectEngulfing(h4, i).detected && detectEngulfing(h4, i).details?.direction === "bullish"
      || (detectOutsideBar(h4, i).detected && detectOutsideBar(h4, i).details?.direction === "bullish")
      || (detectAsianRangeBreak(h4, i).detected && detectAsianRangeBreak(h4, i).details?.direction === "bullish");
    if (sig) {
      counts.sig++;
      if (live !== current) {
        counts.sig_live_vs_current_diff++;
        if (live === "bullish" && current !== "bullish") counts.sig_live_bull_current_bear++;
        if (live !== "bullish" && current === "bullish") counts.sig_live_bear_current_bull++;
        if (examples.length < 6) examples.push(`${bar.date} live=${live} current=${current} intended=${intended}`);
        // simulate the affected signals per matching algo (ATR gate applied as the engine would)
        if (checkAtrLiquidity(h4, i).skip) continue;
        const fired: string[] = [];
        if (detectEngulfing(h4, i).detected && detectEngulfing(h4, i).details?.direction === "bullish") fired.push("engulfing");
        if (detectOutsideBar(h4, i).detected && detectOutsideBar(h4, i).details?.direction === "bullish") fired.push("outside_bar");
        if (detectAsianRangeBreak(h4, i).detected && detectAsianRangeBreak(h4, i).details?.direction === "bullish") fired.push("asian_range_break");
        for (const pat of fired) for (const m of byPattern[pat] ?? []) {
          const r = simulate(h4, i, m.rules as never);
          if (r === null) continue;
          (live === "bullish" ? liveOnly : btOnly).push({ r, algo: m.label, date: bar.date });
        }
      }
    }
  }
  console.log(`bars=${counts.bars}  bias differs LIVE vs CURRENT on ${counts.live_vs_current_diff} (${(100 * counts.live_vs_current_diff / counts.bars).toFixed(2)}%), LIVE vs INTENDED ${counts.live_vs_intended_diff} (${(100 * counts.live_vs_intended_diff / counts.bars).toFixed(2)}%), CURRENT vs INTENDED ${counts.current_vs_intended_diff}`);
  console.log(`by bar start hour (UTC) — bars / LIVE≠CURRENT: ` + Object.entries(counts.byHour).map(([h, v]) => `${h}:${v.bars}/${v.diff}`).join("  "));
  console.log(`pattern-signal bars (bullish engulfing|outside|ARB): ${counts.sig}; bias differs on ${counts.sig_live_vs_current_diff} (${(100 * counts.sig_live_vs_current_diff / counts.sig).toFixed(2)}%): live-bullish/backtest-not ${counts.sig_live_bull_current_bear} (trades LIVE takes, backtest skips), live-not/backtest-bullish ${counts.sig_live_bear_current_bull} (trades backtest takes, LIVE skips)`);
  console.log("examples: " + examples.join(" | "));
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
  const wr = (xs: Array<{ r: number }>) => (xs.length ? (100 * xs.filter((x) => x.r > 0).length) / xs.length : NaN);
  console.log(`mini-sim (gross R, ATR gate applied, no sibling gating): LIVE-only signals n=${liveOnly.length} meanR=${mean(liveOnly.map((x) => x.r)).toFixed(3)} WR=${wr(liveOnly).toFixed(1)}%  |  BACKTEST-only signals n=${btOnly.length} meanR=${mean(btOnly.map((x) => x.r)).toFixed(3)} WR=${wr(btOnly).toFixed(1)}%`);
  (counts as Record<string, unknown>).mini_sim = { live_only: { n: liveOnly.length, mean_r: mean(liveOnly.map((x) => x.r)), wr: wr(liveOnly) }, backtest_only: { n: btOnly.length, mean_r: mean(btOnly.map((x) => x.r)), wr: wr(btOnly) } };
  writeFileSync("review/results/bias-alignment.json", JSON.stringify({ ...counts, examples, generated_at: new Date().toISOString() }, null, 1));
}
main().catch((e) => { console.error(e); process.exit(1); });
