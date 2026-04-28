/**
 * Break of Structure (BOS) — the classic ICT/SMC trend-continuation
 * signal. Bullish BOS fires when the current bar's CLOSE prints above
 * the most recent confirmed swing high; bearish mirror.
 *
 * "Confirmed" means the swing has its full ±lookback window of bars
 * around it already in the past — we don't peek at future bars to
 * confirm a swing that just formed. Detection is causal so the same
 * bar index i in backtest replay returns the same answer as it would
 * in live evaluation.
 *
 * Use as an entry trigger: bullish BOS = trend-resumption long; bearish
 * BOS = trend-resumption short. Pair with daily_bias for filter,
 * liquidity_sweep + FVG for higher-conviction stacks.
 */
import type { PriceBar } from "@/lib/market-data/types";
import { detectSwingPoints } from "./swing-points";
import type { PatternResult } from "./types";

export interface BosDetails {
  direction: "bullish" | "bearish";
  /** The swing level that was broken. */
  broken_level: number;
  /** Index of the swing that was broken. */
  broken_swing_idx: number;
  /** Price that triggered the break (closing price of bar `idx`). */
  break_close: number;
}

/**
 * Detect a BOS event AT BAR `idx`. Returns detected=true only when the
 * close of `bars[idx]` strictly crosses the most recent confirmed swing.
 * "Most recent" means closest swing whose own index is at least
 * `lookback` bars back so the swing is already validated.
 */
export function detectBos(
  bars: PriceBar[],
  idx: number,
  lookback: number = 5
): PatternResult<BosDetails> {
  if (idx < lookback * 2 + 1 || idx >= bars.length) return { detected: false };
  const swings = detectSwingPoints(bars.slice(0, idx + 1), lookback);
  if (swings.length === 0) return { detected: false };

  const close = bars[idx].close;
  // Walk swings backwards to find the most recent confirmed high + low.
  let lastHigh: { idx: number; price: number } | null = null;
  let lastLow: { idx: number; price: number } | null = null;
  for (let s = swings.length - 1; s >= 0; s--) {
    const sw = swings[s];
    if (sw.idx > idx - lookback) continue; // not confirmed yet
    if (!lastHigh && sw.type === "high") lastHigh = { idx: sw.idx, price: sw.price };
    if (!lastLow && sw.type === "low") lastLow = { idx: sw.idx, price: sw.price };
    if (lastHigh && lastLow) break;
  }

  // Bullish BOS: close strictly above the recent swing high.
  if (lastHigh && close > lastHigh.price) {
    return {
      detected: true,
      details: {
        direction: "bullish",
        broken_level: lastHigh.price,
        broken_swing_idx: lastHigh.idx,
        break_close: close,
      },
    };
  }
  // Bearish BOS.
  if (lastLow && close < lastLow.price) {
    return {
      detected: true,
      details: {
        direction: "bearish",
        broken_level: lastLow.price,
        broken_swing_idx: lastLow.idx,
        break_close: close,
      },
    };
  }
  return { detected: false };
}
