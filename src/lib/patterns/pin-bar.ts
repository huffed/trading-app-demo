/**
 * Pin bar — single-candle rejection pattern. One long wick rejecting
 * a price level, with the body closing in the opposite half of the
 * range.
 *
 * Why this matters: friend-trade replay (multi-tf-friend-replay.ts)
 * showed pin bar fires on 13% of his 4h entries (direction-aligned)
 * vs 8% on 1h. He's clearly reading rejection-wick price action.
 *
 * Bullish pin bar: lower wick ≥ wick_to_body_ratio × body, body in
 *   upper half of range, upper wick small. Rejection of lower prices.
 *
 * Bearish pin bar: upper wick ≥ ratio × body, body in lower half,
 *   lower wick small. Rejection of upper prices.
 *
 * Defaults match the replay script's heuristic so production gating
 * matches the offline analysis: ratio=2.0, opposite-wick must be ≤ ½
 * the dominant wick.
 */
import type { PriceBar } from "@/lib/market-data/types";
import type { PatternResult } from "./types";

export interface PinBarDetails {
  direction: "bullish" | "bearish";
  body: number;
  /** Length of the dominant wick (lower for bullish, upper for bearish). */
  wick: number;
  /** Length of the opposing wick — informative for setups where the
   *  rejection isn't pristine but still qualifies. */
  opposite_wick: number;
}

export interface PinBarOptions {
  /** Min ratio of dominant wick to body. Default 2 — wick must be at
   *  least 2× the body to qualify. */
  wick_to_body_ratio?: number;
  /** Max ratio of opposite wick to dominant wick. Default 0.5 — the
   *  rejection has to be lopsided; equal wicks aren't a pin bar. */
  max_opposite_ratio?: number;
}

const DEFAULTS = {
  wick_to_body_ratio: 2.0,
  max_opposite_ratio: 0.5,
} as const;

export function detectPinBar(
  bars: PriceBar[],
  idx: number,
  options: PinBarOptions = {}
): PatternResult<PinBarDetails> {
  if (idx < 0 || idx >= bars.length) return { detected: false };
  const ratio = options.wick_to_body_ratio ?? DEFAULTS.wick_to_body_ratio;
  const oppRatio = options.max_opposite_ratio ?? DEFAULTS.max_opposite_ratio;

  const bar = bars[idx];
  const body = Math.abs(bar.close - bar.open);
  if (body === 0) return { detected: false }; // doji — not a pin bar
  const upperWick = bar.high - Math.max(bar.open, bar.close);
  const lowerWick = Math.min(bar.open, bar.close) - bar.low;

  // Bullish: long lower wick, body up top, upper wick small relative
  // to lower wick.
  if (lowerWick >= ratio * body && upperWick <= oppRatio * lowerWick) {
    return {
      detected: true,
      details: {
        direction: "bullish",
        body: Number(body.toFixed(8)),
        wick: Number(lowerWick.toFixed(8)),
        opposite_wick: Number(upperWick.toFixed(8)),
      },
    };
  }
  // Bearish: long upper wick.
  if (upperWick >= ratio * body && lowerWick <= oppRatio * upperWick) {
    return {
      detected: true,
      details: {
        direction: "bearish",
        body: Number(body.toFixed(8)),
        wick: Number(upperWick.toFixed(8)),
        opposite_wick: Number(lowerWick.toFixed(8)),
      },
    };
  }
  return { detected: false };
}
