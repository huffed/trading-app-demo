/**
 * Liquidity sweep detection — the "stop hunt" pattern. Price spikes
 * through a recent swing level (taking out resting stop-loss orders) then
 * reverses back inside, suggesting a higher-timeframe player just absorbed
 * the liquidity and is about to push the other direction.
 *
 *   Bullish sweep (long signal): bar.low < swing_low, bar.close > swing_low
 *   Bearish sweep (short signal): bar.high > swing_high, bar.close < swing_high
 *
 * The signal is the bar that did the piercing AND closed back inside.
 * Whether to take the trade depends on confluence with daily bias / FVG /
 * other context — this detector just reports the structural pattern.
 */
import type { PriceBar } from "@/lib/market-data/types";
import { detectSwingPoints, lastSwingBefore } from "./swing-points";
import type { LiquiditySweepDetails, PatternResult } from "./types";

/**
 * Check whether the bar at `idx` swept liquidity above the most recent
 * swing high (bearish) or below the most recent swing low (bullish).
 *
 * `lookback` controls swing point detection — same convention as
 * `detectSwingPoints` (default 5). Pass pre-computed swings via the third
 * argument when scanning many bars to avoid recomputing.
 */
export function detectLiquiditySweep(
  bars: PriceBar[],
  idx: number,
  lookback: number = 5
): PatternResult<LiquiditySweepDetails> {
  if (idx < 0 || idx >= bars.length) return { detected: false };

  const bar = bars[idx];
  // Pre-slice to bars[0..idx] so swing detection only sees historical bars.
  // detectSwingPoints uses ±lookback windows to confirm swings; passing the
  // full array would let a swing at idx-1 be "confirmed" using future bars
  // (look-ahead bias, sister of the daily_bias bug fix 2026-06-17).
  const swings = detectSwingPoints(bars.slice(0, idx + 1), lookback);

  // Bearish sweep — pierced a previous swing high, then closed back below.
  const swingHigh = lastSwingBefore(swings, idx, "high");
  if (swingHigh && bar.high > swingHigh.price && bar.close < swingHigh.price) {
    return {
      detected: true,
      details: {
        direction: "bearish",
        swept_level: swingHigh.price,
        swept_idx: swingHigh.idx,
        sweep_idx: idx,
      },
    };
  }

  // Bullish sweep — pierced a previous swing low, then closed back above.
  const swingLow = lastSwingBefore(swings, idx, "low");
  if (swingLow && bar.low < swingLow.price && bar.close > swingLow.price) {
    return {
      detected: true,
      details: {
        direction: "bullish",
        swept_level: swingLow.price,
        swept_idx: swingLow.idx,
        sweep_idx: idx,
      },
    };
  }

  return { detected: false };
}
