/**
 * Type definitions for the ICT/SMC pattern detection module.
 *
 * Detectors are pure functions over bar series. They operate on the same
 * `PriceBar[]` shape the indicator engine uses (`lib/market-data/types`),
 * so the input is the same arrays already cached + fetched by the rest of
 * the system. Output is structured `PatternResult` objects rather than
 * raw booleans so the UI can show "swept above 1.0850 at 14:30" instead
 * of just "true".
 *
 * No state — each detector is given everything it needs in its inputs.
 * Stateful patterns (e.g. IFVG that tracks previously-filled FVGs across
 * scans) compose multiple detector calls at the call site.
 */

/** A swing point — local high or local low — used as a building block. */
export interface SwingPoint {
  /** Index in the input bar array. */
  idx: number;
  /** The swing price (high for "high" type, low for "low" type). */
  price: number;
  type: "high" | "low";
}

/** Generic detector result. `details` is shape-specific. */
export interface PatternResult<TDetails = Record<string, unknown>> {
  detected: boolean;
  /** Detail payload for the UI / activity log when detected is true. */
  details?: TDetails;
}

export interface FvgDetails {
  direction: "bullish" | "bearish";
  /** The price-gap top edge (highest price inside the gap). */
  gap_top: number;
  /** The price-gap bottom edge (lowest price inside the gap). */
  gap_bottom: number;
  /** Bar index where the gap was created (the middle bar of the 3-bar pattern). */
  created_at_idx: number;
}

export interface LiquiditySweepDetails {
  direction: "bullish" | "bearish";
  /** The swing level that got pierced. */
  swept_level: number;
  /** The swing point's original index. */
  swept_idx: number;
  /** Index of the bar that did the sweep. */
  sweep_idx: number;
}

export interface DailyBiasDetails {
  bias: "bullish" | "bearish" | "neutral";
  /** Latest D1 close used for the bias decision. */
  close: number;
  /** The MA value compared against the close. */
  ma_value: number;
  /** Period of the MA used (typically 20). */
  ma_period: number;
}
