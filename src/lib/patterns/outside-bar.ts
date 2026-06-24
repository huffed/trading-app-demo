/**
 * Outside bar — volatility-expansion pattern where the current bar's
 * range FULLY ENGULFS the previous bar's range AND closes directionally.
 *
 * Distinct from engulfing: engulfing requires BODY engulf; outside bar
 * requires the FULL RANGE (high+low) to engulf. Many engulfing patterns
 * don't have full-range engulfment (wicks didn't expand), and many
 * outside bars don't have body engulfment (wide candle but small body).
 *
 * Bullish outside bar: cur.high > prev.high AND cur.low < prev.low AND
 *   cur.close > cur.open (bullish close). Indicates strong buy pressure
 *   after a range-expansion bar — buyer takeover.
 *
 * Bearish outside bar: cur.high > prev.high AND cur.low < prev.low AND
 *   cur.close < cur.open (bearish close). Indicates strong sell pressure.
 *
 * Strict-range engulfing — equal highs/lows don't qualify. Doji-close
 * current bars are ambiguous-direction → not detected.
 */
import type { PriceBar } from "@/lib/market-data/types";
import type { PatternResult } from "./types";

export interface OutsideBarDetails {
  direction: "bullish" | "bearish";
  /** Current bar's range — engulfs previous bar's. */
  cur_high: number;
  cur_low: number;
  /** Previous bar's range — engulfed by current bar's. */
  prev_high: number;
  prev_low: number;
  /** Range expansion ratio (cur_range / prev_range). Useful for filtering
   *  marginal engulfings vs decisive ones. */
  range_expansion_ratio: number;
}

export function detectOutsideBar(
  bars: PriceBar[],
  idx: number,
): PatternResult<OutsideBarDetails> {
  if (idx <= 0 || idx >= bars.length) return { detected: false };
  const prev = bars[idx - 1];
  const cur = bars[idx];
  // Strict range engulf — equal highs/lows don't qualify.
  if (!(cur.high > prev.high && cur.low < prev.low)) return { detected: false };
  let direction: "bullish" | "bearish" | null;
  if (cur.close > cur.open) direction = "bullish";
  else if (cur.close < cur.open) direction = "bearish";
  else direction = null;
  if (direction === null) return { detected: false }; // doji close — ambiguous
  const prevRange = prev.high - prev.low;
  const curRange = cur.high - cur.low;
  const ratio = prevRange > 0 ? curRange / prevRange : Number.POSITIVE_INFINITY;
  return {
    detected: true,
    details: {
      direction,
      cur_high: cur.high,
      cur_low: cur.low,
      prev_high: prev.high,
      prev_low: prev.low,
      range_expansion_ratio: Number(ratio.toFixed(4)),
    },
  };
}
