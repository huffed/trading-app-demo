/**
 * Risk calibration — scale a search-found candidate's position sizing
 * to match the user's monthly return target subject to FTMO-safe caps.
 *
 * The combinatorial search produces candidates at a fixed base risk
 * (currently 0.5%). To hit a user's stated monthly target, scale the
 * `position_sizing.value` by `target / achieved`. Cap the result so
 * peak per-trade risk never exceeds the FTMO-safe ceiling — algorithms
 * that need 5% risk to hit a 10% monthly target get the cap, and the
 * caller surfaces the gap to the user.
 *
 * Caps (per per-trade-risk, NOT per-month-return):
 *   risk_per_trade        ≤ 2.0% per trade
 *   conviction_scaled     ≤ 2.0% PEAK risk (base × max_multiplier)
 *   percentage_of_capital ≤ 100% (structural; not really risk-bounded)
 *
 * Memory note (`feedback_funded_trading.md`): walk-forward proved 0.7%
 * is the FTMO sweet spot. We allow up to 2.0% so search candidates
 * with strong walk-forward stability can still hit aggressive targets,
 * but anything above 1.5% should be treated as "aggressive" — the
 * caller's responsibility to surface that to the user.
 */
import type { AlgorithmRules } from "@/types/algorithm";

const RISK_PER_TRADE_CAP_PCT = 2.0;
/** Peak per-trade risk for conviction_scaled — base × max_multiplier. */
const CONVICTION_PEAK_CAP_PCT = 2.0;
/** Lower bound — keeps the algorithm tradeable even when calibration
 *  factor would otherwise round to zero. */
const MIN_RISK_PCT = 0.1;

export interface CalibrationResult {
  /** Calibrated rules — same shape as input but with `position_sizing.value`
   *  scaled. Other fields untouched. */
  rules: AlgorithmRules;
  /** Multiplier applied to the original `position_sizing.value`. */
  scaling_factor: number;
  /** Original sizing value before calibration. */
  original_value: number;
  /** Calibrated sizing value after caps. */
  calibrated_value: number;
  /** True when the cap bound bit — calibrated risk would have been
   *  higher than safe, so target may not be hit. */
  capped: boolean;
  /** Estimated monthly return AFTER calibration, assuming linear
   *  scaling between risk and return. */
  estimated_monthly_pct: number;
  /** True when sizing type isn't calibratable (lots, fixed_amount,
   *  fixed_quantity) — passes through unchanged. */
  passthrough: boolean;
}

/**
 * Scale `rules.position_sizing.value` to bring a candidate's expected
 * monthly return up to (or as close as possible to) `target_monthly_pct`.
 *
 * Pure function — no DB, no side effects. Caller persists the result
 * if they want.
 */
export function calibrateRiskToTarget(
  rules: AlgorithmRules,
  achieved_monthly_pct: number,
  target_monthly_pct: number
): CalibrationResult {
  const sizing = rules.position_sizing;
  const passthroughTypes: typeof sizing.type[] = ["lots", "fixed_amount", "fixed_quantity"];
  if (passthroughTypes.includes(sizing.type)) {
    return {
      rules,
      scaling_factor: 1,
      original_value: sizing.value,
      calibrated_value: sizing.value,
      capped: false,
      estimated_monthly_pct: achieved_monthly_pct,
      passthrough: true,
    };
  }

  if (achieved_monthly_pct <= 0) {
    // Negative or zero baseline — calibration would invert or divide by
    // zero. Return passthrough; caller should surface the candidate
    // failed before reaching this stage anyway.
    return {
      rules,
      scaling_factor: 1,
      original_value: sizing.value,
      calibrated_value: sizing.value,
      capped: false,
      estimated_monthly_pct: achieved_monthly_pct,
      passthrough: true,
    };
  }

  const desiredScaling = target_monthly_pct / achieved_monthly_pct;
  const desiredValue = sizing.value * desiredScaling;

  // Apply per-type caps.
  let calibratedValue = desiredValue;
  let capped = false;
  if (sizing.type === "risk_per_trade") {
    if (calibratedValue > RISK_PER_TRADE_CAP_PCT) {
      calibratedValue = RISK_PER_TRADE_CAP_PCT;
      capped = true;
    }
  } else if (sizing.type === "conviction_scaled") {
    const maxMult = sizing.max_multiplier ?? 4;
    const peakIfApplied = calibratedValue * maxMult;
    if (peakIfApplied > CONVICTION_PEAK_CAP_PCT) {
      calibratedValue = CONVICTION_PEAK_CAP_PCT / maxMult;
      capped = true;
    }
  } else if (sizing.type === "percentage_of_capital") {
    if (calibratedValue > 100) {
      calibratedValue = 100;
      capped = true;
    }
  }
  // Apply floor.
  if (calibratedValue < MIN_RISK_PCT) {
    calibratedValue = MIN_RISK_PCT;
  }

  // Round to a sensible precision so 0.5837391 doesn't end up in the
  // database. 2 decimal places matches the granularity operators tend to
  // think in (0.5%, 0.7%, 1.2%).
  calibratedValue = Number(calibratedValue.toFixed(2));

  const actualScaling = calibratedValue / sizing.value;
  const estimatedMonthly = achieved_monthly_pct * actualScaling;

  return {
    rules: {
      ...rules,
      position_sizing: { ...sizing, value: calibratedValue },
    },
    scaling_factor: actualScaling,
    original_value: sizing.value,
    calibrated_value: calibratedValue,
    capped,
    estimated_monthly_pct: estimatedMonthly,
    passthrough: false,
  };
}
