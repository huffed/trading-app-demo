/**
 * Doji — indecision candle where the body is very small relative to the
 * range. Classic price-action signal of buyer/seller equilibrium —
 * often precedes a reversal or breakout depending on prior trend.
 *
 * Body-to-range ratio threshold: body ≤ body_to_range_ratio × range
 * (default 0.1 = body is ≤ 10% of the total range). This is the standard
 * doji definition; tighter thresholds (≤5%) identify "perfect" dojis.
 *
 * Doji is direction-AGNOSTIC (the close ≈ open is the whole point).
 * Returns direction=undefined when detected; consumers that need a
 * directional bias should combine with daily_bias or a regime classifier.
 *
 * Edge case: zero-range bars (high == low) are technically dojis but
 * indicate a degenerate / stale bar — explicitly rejected to avoid
 * false positives from missing-data fills.
 */
import type { PriceBar } from "@/lib/market-data/types";
import type { PatternResult } from "./types";

export interface DojiDetails {
  /** Body size = |close - open|. */
  body: number;
  /** Range = high - low. */
  range: number;
  /** Body / range ratio. Lower = more indecisive. */
  body_to_range_ratio: number;
  /** Doji subtype: long-legged (both wicks ≥ body); dragonfly (lower wick
   *  dominates); gravestone (upper wick dominates); standard (none of the
   *  above). */
  subtype: "standard" | "long_legged" | "dragonfly" | "gravestone";
}

export interface DojiOptions {
  /** Max body-to-range ratio for doji detection. Default 0.1 (= body
   *  must be ≤ 10% of range). Set 0.05 for stricter "perfect doji". */
  body_to_range_ratio?: number;
  /** Long-legged threshold: wick ≥ this × range. Default 0.3 (= each wick
   *  is at least 30% of the range). */
  long_legged_wick_ratio?: number;
  /** Subtype classification: opposite wick is considered "negligible"
   *  when ≤ this × range. Default 0.1 (= opposite wick is ≤ 10% of range).
   *  Tighter than long_legged threshold so a wick can be both
   *  "non-negligible" AND "not long-legged". */
  negligible_wick_ratio?: number;
}

const DEFAULTS = {
  body_to_range_ratio: 0.1,
  long_legged_wick_ratio: 0.3,
  negligible_wick_ratio: 0.1,
} as const;

function classifySubtype(
  upperWick: number,
  lowerWick: number,
  range: number,
  longLeggedRatio: number,
  negligibleRatio: number,
): DojiDetails["subtype"] {
  const upperFrac = upperWick / range;
  const lowerFrac = lowerWick / range;
  // Dragonfly: lower wick is most of range, upper is negligible
  if (upperFrac <= negligibleRatio && lowerFrac >= longLeggedRatio) return "dragonfly";
  // Gravestone: upper wick is most of range, lower is negligible
  if (lowerFrac <= negligibleRatio && upperFrac >= longLeggedRatio) return "gravestone";
  // Long-legged: BOTH wicks significant
  if (upperFrac >= longLeggedRatio && lowerFrac >= longLeggedRatio) {
    return "long_legged";
  }
  return "standard";
}

export function detectDoji(
  bars: PriceBar[],
  idx: number,
  options: DojiOptions = {},
): PatternResult<DojiDetails> {
  if (idx < 0 || idx >= bars.length) return { detected: false };
  const bar = bars[idx];
  const range = bar.high - bar.low;
  if (range <= 0) return { detected: false }; // zero-range = degenerate / stale
  const body = Math.abs(bar.close - bar.open);
  const bodyRatio = body / range;
  const threshold = options.body_to_range_ratio ?? DEFAULTS.body_to_range_ratio;
  if (bodyRatio > threshold) return { detected: false };
  const upperWick = bar.high - Math.max(bar.open, bar.close);
  const lowerWick = Math.min(bar.open, bar.close) - bar.low;
  const subtype = classifySubtype(
    upperWick,
    lowerWick,
    range,
    options.long_legged_wick_ratio ?? DEFAULTS.long_legged_wick_ratio,
    options.negligible_wick_ratio ?? DEFAULTS.negligible_wick_ratio,
  );
  return {
    detected: true,
    details: {
      body: Number(body.toFixed(8)),
      range: Number(range.toFixed(8)),
      body_to_range_ratio: Number(bodyRatio.toFixed(4)),
      subtype,
    },
  };
}
