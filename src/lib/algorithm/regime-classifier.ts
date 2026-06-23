/**
 * H.6 — Vol-percentile regime classifier. Bucket each bar into one of
 * three regimes by its ATR(14) percentile against the last 200 bars:
 *
 *   low_vol     — ATR percentile in [0, 33.33)
 *   medium_vol  — ATR percentile in [33.33, 66.67)
 *   high_vol    — ATR percentile in [66.67, 100]
 *
 * Returns null when insufficient lookback (< 200 bars) — caller treats
 * as "unknown regime, skip this bar for regime-conditioned logic".
 *
 * Pre-registered tercile boundaries: 33.33 / 66.67. NOT data-fit.
 * Boundaries are operator-locked; any tuning produces a new regime
 * classifier (versioned via the module name, not the boundary values).
 *
 * Reuses the same `atr14` + `pctile` helpers as H.2's
 * `atr_percentile_200` feature for math consistency. The two are
 * deliberately separate surfaces: H.2 is a feature (numeric input to
 * H.3 xgboost); this module is a categorical CLASSIFIER for routing
 * decisions.
 */
import { atr14, pctile } from "@/lib/market-data/market-state";
import type { PriceBar } from "@/lib/market-data/types";

export const REGIMES = ["low_vol", "medium_vol", "high_vol"] as const;
export type Regime = (typeof REGIMES)[number];

/** Lower bound (inclusive) of the medium_vol regime, in percentile units. */
export const LOW_VOL_UPPER_PCT = 33.33;
/** Lower bound (inclusive) of the high_vol regime, in percentile units. */
export const HIGH_VOL_LOWER_PCT = 66.67;

/** Minimum bars of history before the classifier returns a verdict.
 *  200 matches the H.2 `atr_percentile_200` feature lookback. */
export const REGIME_LOOKBACK_BARS = 200;

/** Classify the regime at `bars[idx]`. Returns null when fewer than
 *  `REGIME_LOOKBACK_BARS` bars are available OR when the ATR computation
 *  itself fails (degenerate input). */
export function classifyRegime(bars: PriceBar[], idx: number): Regime | null {
  if (idx < REGIME_LOOKBACK_BARS) return null;
  const current = atr14(bars, idx);
  if (current == null) return null;
  const history: number[] = [];
  for (let j = idx - (REGIME_LOOKBACK_BARS - 1); j <= idx; j++) {
    const a = atr14(bars, j);
    if (a != null) history.push(a);
  }
  if (history.length < 50) return null; // not enough valid ATR values
  // pctile returns a [0,1] fraction; convert to 0..100 percent so the
  // tercile boundary constants read naturally (33.33 / 66.67).
  const frac = pctile(history, current);
  if (frac == null) return null;
  const pct = frac * 100;
  if (pct < LOW_VOL_UPPER_PCT) return "low_vol";
  if (pct < HIGH_VOL_LOWER_PCT) return "medium_vol";
  return "high_vol";
}

/** Classify every bar from `idx >= REGIME_LOOKBACK_BARS` onwards. Bars
 *  before that get null. Used by the per-regime sweep to build the
 *  bar-to-regime map once instead of per-trade. */
export function classifyAllBars(bars: PriceBar[]): (Regime | null)[] {
  const out: (Regime | null)[] = new Array(bars.length).fill(null);
  for (let i = REGIME_LOOKBACK_BARS; i < bars.length; i++) {
    out[i] = classifyRegime(bars, i);
  }
  return out;
}
