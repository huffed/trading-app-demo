/**
 * Swing-point detection — the foundation primitive for liquidity sweeps,
 * IFVG state tracking, and liquidity-pool clustering.
 *
 * A swing high is a bar whose high is strictly greater than every bar's
 * high in the surrounding ±lookback window. Mirror for swing lows.
 *
 * Lookback of 5 is the ICT-conventional default for intraday timeframes.
 * Larger lookback = fewer but more significant swings; smaller = noisier.
 */
import type { PriceBar } from "@/lib/market-data/types";
import type { SwingPoint } from "./types";

/**
 * Identify all swing highs + swing lows in `bars` using the surrounding
 * ±lookback window comparison. Returns swings sorted by index ascending.
 * The first and last `lookback` bars are skipped — there isn't enough
 * surrounding data to confirm a swing there.
 */
export function detectSwingPoints(bars: PriceBar[], lookback: number = 5): SwingPoint[] {
  if (bars.length < lookback * 2 + 1 || lookback < 1) return [];

  const swings: SwingPoint[] = [];
  for (let i = lookback; i < bars.length - lookback; i++) {
    const center = bars[i];
    let isHigh = true;
    let isLow = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if (bars[j].high >= center.high) isHigh = false;
      if (bars[j].low <= center.low) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) swings.push({ idx: i, price: center.high, type: "high" });
    if (isLow) swings.push({ idx: i, price: center.low, type: "low" });
  }
  return swings;
}

/**
 * Convenience: find the most recent swing of a given type before `idx`.
 * Returns null when no qualifying swing exists. Used by the liquidity
 * sweep detector to ask "what was the last swing high before this bar?".
 */
export function lastSwingBefore(
  swings: SwingPoint[],
  idx: number,
  type: "high" | "low"
): SwingPoint | null {
  for (let i = swings.length - 1; i >= 0; i--) {
    if (swings[i].idx >= idx) continue;
    if (swings[i].type === type) return swings[i];
  }
  return null;
}
