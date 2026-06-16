/**
 * Mean-reversion pattern — fires when price has stretched away from a
 * trailing mean and the current bar shows a reversal candle. Classic
 * fade-the-extreme signal common in forex range/chop conditions where
 * trending strategies underperform.
 *
 * Why this is in the library: V1 cluster mining on EUR/USD (2026-06-16)
 * surfaced that equilibrium-zone entries dominate (test meanR 0.77),
 * the structural opposite of gold's premium-zone bias. The existing
 * pattern library (BOS / sweep / FVG / OB) all fire at extremes or
 * after impulse moves — none captures the "fade an overshoot" idea
 * directly. This detector closes that gap.
 *
 * Detection (parameterised — defaults match a standard Bollinger setup):
 *   1. Compute trailing N-bar mean + sample stdev of close prices
 *      (default N=20).
 *   2. Reference bar = `idx - 1` (the most recently CLOSED bar's
 *      stretch position before the current bar's reversal — guards
 *      against "stretched THIS bar and we're calling the bottom
 *      simultaneously").
 *   3. Bullish setup: ref_close was ≤ mean - K·stdev (default K=1.5)
 *      AND current bar shows a bullish reversal (close > open AND
 *      close > ref_close).
 *   4. Bearish setup: ref_close was ≥ mean + K·stdev AND current bar
 *      shows a bearish reversal (close < open AND close < ref_close).
 *
 * Returns `{ detected: false }` when there aren't enough bars to
 * compute a meaningful mean + stdev (need ≥ lookback + 1).
 *
 * This pattern is INSTRUMENT-AGNOSTIC by design — uses the bars'
 * native scale for stdev, so it works on FX, gold, equities without
 * tuning thresholds per instrument.
 */
import type { PriceBar } from "@/lib/market-data/types";
import type { PatternResult } from "./types";

export interface MeanReversionDetails {
  direction: "bullish" | "bearish";
  /** Trailing N-bar mean of close prices used for the comparison. */
  mean: number;
  /** Sample standard deviation of the N-bar closes. */
  stdev: number;
  /** Number of stdevs ref_close was from mean (signed; negative = below). */
  z_score: number;
  /** The bar (idx - 1) close used as reference for the stretch. */
  ref_close: number;
  /** Current bar close (the reversal-confirmation bar). */
  break_price: number;
}

export interface MeanReversionConfig {
  lookback?: number; // default 20
  stdevThreshold?: number; // default 1.5
}

export function detectMeanReversion(
  bars: PriceBar[],
  idx: number,
  config: MeanReversionConfig = {}
): PatternResult<MeanReversionDetails> {
  const lookback = config.lookback ?? 20;
  const k = config.stdevThreshold ?? 1.5;

  if (idx < lookback + 1 || idx >= bars.length) return { detected: false };

  const refBar = bars[idx - 1];
  const curBar = bars[idx];
  if (!refBar || !curBar) return { detected: false };

  // Compute mean + stdev over the N bars BEFORE the reference bar.
  // (Use idx-lookback-1 .. idx-2 inclusive — N bars ending at the bar
  // before the reference.) This avoids contaminating the trailing
  // window with the reference bar itself.
  const windowStart = idx - lookback - 1;
  const windowEnd = idx - 2; // inclusive
  let sum = 0;
  for (let i = windowStart; i <= windowEnd; i++) sum += bars[i].close;
  const mean = sum / lookback;
  let sqSum = 0;
  for (let i = windowStart; i <= windowEnd; i++) {
    const d = bars[i].close - mean;
    sqSum += d * d;
  }
  // Sample stdev (n-1 divisor) for unbiased estimate.
  const stdev = Math.sqrt(sqSum / (lookback - 1));
  if (stdev === 0 || !Number.isFinite(stdev)) return { detected: false };

  const z = (refBar.close - mean) / stdev;

  // Bullish: stretched DOWN past -K, current bar reverses up.
  if (z <= -k) {
    const reversed = curBar.close > curBar.open && curBar.close > refBar.close;
    if (reversed) {
      return {
        detected: true,
        details: {
          direction: "bullish",
          mean,
          stdev,
          z_score: z,
          ref_close: refBar.close,
          break_price: curBar.close,
        },
      };
    }
  }

  // Bearish: stretched UP past +K, current bar reverses down.
  if (z >= k) {
    const reversed = curBar.close < curBar.open && curBar.close < refBar.close;
    if (reversed) {
      return {
        detected: true,
        details: {
          direction: "bearish",
          mean,
          stdev,
          z_score: z,
          ref_close: refBar.close,
          break_price: curBar.close,
        },
      };
    }
  }

  return { detected: false };
}
