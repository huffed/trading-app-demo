/**
 * Vol-targeting position sizing (G.3 / `position_sizing.type="vol_target"`).
 *
 * Canonical institutional sizing model — set a target portfolio volatility,
 * size each position so its expected risk contribution equals that target.
 * Inverse-vol scaling: high-vol instrument → smaller position; low-vol →
 * larger. Adapts to regime changes automatically without re-fitting the algo.
 *
 * Spec formula (per `scripts/canonical/ROADMAP.md` G.3):
 *
 *   position_notional = capital × target_vol_pct
 *                       / max(per_trade_R_std × instrument_vol_pct, MIN_VOL_FLOOR)
 *
 * Components:
 *   - `target_vol_pct` — operator-set target portfolio vol (dimensionless;
 *     0.05 = 5%). For FTMO-safe sizing under 5% daily DD + 10% static DD
 *     limits, 0.04–0.06 is a reasonable range.
 *   - `per_trade_R_std` — empirical stddev of the algo's recent per-trade
 *     R-multiples (dimensionless). Captures how dispersed the algo's
 *     outcomes are (mean-reverting algos cluster tighter than breakout
 *     algos). Warmup fallback `VOL_TARGET_WARMUP_FALLBACK_R_STD = 1.0`
 *     used when fewer than 2 trades are available — assume one R unit
 *     of dispersion, a conservative default for any rule-based algo.
 *   - `instrument_vol_pct` — current instrument volatility as fraction
 *     of price (dimensionless; ATR(14)/price). Caller computes from the
 *     bar series.
 *   - `MIN_VOL_FLOOR` — denominator floor preventing explosive sizing on
 *     quiet bars / pathological inputs. Default 0.002 (= 0.2% combined
 *     vol-product floor) caps notional at ~`capital × target_vol_pct / 0.002`.
 *     At target=5% + floor=0.002 the ceiling is `capital × 25`; with the
 *     downstream margin check + broker leverage cap (typically 30×), this
 *     stays below blow-up territory even in quiet-market edge cases.
 *
 * NOT wired into the scan/live path yet — the Engulfing rr3_lb6_r06 v3
 * survivor uses `risk_per_trade`, so live deployment doesn't need this
 * until backtest validates the approach (G.3 gate: ≥10% Sharpe improvement
 * OR documented why not). Live wire-up is filed as G.3-followup.
 */

/** Fallback per-trade R stddev used during the warmup period (< 2 trades
 *  available). Assumes one R unit of dispersion — conservative default
 *  for any rule-based algo (real per-trade R stddev is typically 1.0–2.5
 *  per friend-replay + 6-yr in-sample). */
export const VOL_TARGET_WARMUP_FALLBACK_R_STD = 1.0;

/** Default denominator floor (dimensionless). 0.002 = 0.2% combined
 *  vol-product floor. See module docstring for the ceiling math. */
export const DEFAULT_MIN_VOL_FLOOR = 0.002;

/** Default rolling-window length for per-trade R stddev. 20 is the
 *  standard short-window vol estimator length; trades off responsiveness
 *  (smaller = faster regime adaptation) vs noise (larger = stabler). */
export const DEFAULT_ROLLING_WINDOW = 20;

export interface VolTargetSizingInputs {
  /** Operator-set target portfolio volatility, dimensionless (0.05 = 5%). */
  target_vol_pct: number;
  /** Algo's per-trade R stddev. Null when the warmup fallback should be
   *  used (fewer than 2 historical trades). */
  per_trade_r_std: number | null;
  /** Instrument volatility as fraction of price (0.005 = 0.5% ATR/price). */
  instrument_vol_pct: number;
  /** Account capital. */
  capital: number;
  /** Optional denominator floor override. Defaults to DEFAULT_MIN_VOL_FLOOR. */
  min_vol_floor?: number;
}

export interface VolTargetSizingResult {
  /** Computed notional in account currency. ≥ 0; never negative. */
  notional: number;
  /** R-stddev actually used (real-or-fallback). For audit/log. */
  effective_per_trade_r_std: number;
  /** Denominator actually used (after floor application). For audit/log. */
  effective_vol_denominator: number;
  /** Min-vol floor used (the override or DEFAULT_MIN_VOL_FLOOR). */
  effective_min_vol_floor: number;
  /** True iff the warmup fallback R-stddev was used. */
  used_warmup_fallback: boolean;
  /** True iff the min-vol floor was binding (raw denominator < floor). */
  floor_was_binding: boolean;
}

/** Pure function. Computes notional via the spec formula with documented
 *  fallbacks for warmup + min-vol floor. Returns audit fields alongside
 *  the notional so callers can log why a particular size was chosen. */
export function computeVolTargetNotional(
  inputs: VolTargetSizingInputs,
): VolTargetSizingResult {
  const minFloor = inputs.min_vol_floor ?? DEFAULT_MIN_VOL_FLOOR;
  const useFallback =
    inputs.per_trade_r_std === null ||
    !Number.isFinite(inputs.per_trade_r_std) ||
    inputs.per_trade_r_std <= 0;
  const rStd = useFallback
    ? VOL_TARGET_WARMUP_FALLBACK_R_STD
    : (inputs.per_trade_r_std as number);
  // Guard pathological inputs (negative / NaN instrument vol). Treat as
  // 0 → floor binds → max conservative position.
  const instVol = Number.isFinite(inputs.instrument_vol_pct) && inputs.instrument_vol_pct > 0
    ? inputs.instrument_vol_pct
    : 0;
  const rawDenominator = rStd * instVol;
  const denominator = Math.max(rawDenominator, minFloor);
  const numerator = inputs.capital * inputs.target_vol_pct;
  const notional = numerator > 0 && denominator > 0 ? numerator / denominator : 0;
  return {
    notional: Math.max(0, notional),
    effective_per_trade_r_std: rStd,
    effective_vol_denominator: denominator,
    effective_min_vol_floor: minFloor,
    used_warmup_fallback: useFallback,
    floor_was_binding: rawDenominator < minFloor,
  };
}

/** Compute rolling stddev of per-trade R-multiples over the most recent
 *  `windowSize` trades. Returns null if fewer than 2 trades — caller uses
 *  warmup fallback. Sample stddev (denominator = n-1) for unbiased
 *  estimation. */
export function rollingPerTradeRStd(
  rMultiples: readonly number[],
  windowSize: number = DEFAULT_ROLLING_WINDOW,
): number | null {
  if (rMultiples.length < 2) return null;
  if (windowSize < 2) return null;
  const start = Math.max(0, rMultiples.length - windowSize);
  const window = rMultiples.slice(start);
  if (window.length < 2) return null;
  const mean = window.reduce((s, x) => s + x, 0) / window.length;
  const variance =
    window.reduce((s, x) => s + (x - mean) * (x - mean), 0) / (window.length - 1);
  return Math.sqrt(variance);
}
