/**
 * Deflated Sharpe Ratio (DSR) — Bailey & López de Prado (2014).
 *
 * The Sharpe ratio of the "winning" strategy out of N tested strategies is
 * inflated by selection bias + finite-sample variance + non-normality. DSR
 * adjusts the reported Sharpe for:
 *   - Number of trials (N) — selection bias correction
 *   - Variance of Sharpes across the trial family — captures search breadth
 *   - Skewness of returns — non-normal upside vs downside asymmetry
 *   - Excess kurtosis of returns — fat-tail penalty
 *   - Sample size (T trades) — finite-sample noise
 *
 * Returns a probability ∈ [0, 1] interpreted as: "the probability that the
 * observed Sharpe would NOT have been achieved by chance under the null
 * hypothesis 'no real edge after accounting for the search.'"
 *
 * DSR ≥ 0.95 is the conventional ship-threshold (analogous to p ≤ 0.05).
 * DSR ≥ 0.5 is the "more likely real than not" floor (used in
 * scripts/canonical/ROADMAP.md Phase F.5 v3 criterion: combined with the
 * DSR-adjusted CI lower > 0 criterion + PBO < 0.5).
 *
 * Reference: Bailey, D.H., & López de Prado, M. (2014). "The Deflated
 * Sharpe Ratio: Correcting for Selection Bias, Backtest Overfitting, and
 * Non-Normality." Journal of Portfolio Management, 40(5), 94–107.
 *
 * Used by:
 *   - validate-algo.ts (when KFOLD=1 OR DEFLATED=1 — Phase F.4 forward)
 *   - src/lib/algo-search/criteria.ts (Phase F.5 v3 criterion)
 *   - manual ad-hoc evaluation
 */

/** Euler–Mascheroni constant. Used in the expected-max-Sharpe formula
 *  per Bailey/Prado equation (8). */
const EULER_MASCHERONI = 0.5772156649015329;

/** Standard normal CDF Φ(x). Abramowitz & Stegun 26.2.17 approximation,
 *  ~1e-7 absolute error. Sufficient for DSR use (we don't need tail
 *  precision past ~7 sigma). */
export function standardNormalCdf(x: number): number {
  if (!Number.isFinite(x)) return x > 0 ? 1 : 0;
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp((-x * x) / 2);
  const p =
    d *
    t *
    (0.31938153 +
      t *
        (-0.356563782 +
          t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}

/** Inverse standard normal CDF Φ⁻¹(p). Peter Acklam's rational approximation,
 *  ~1.15e-9 relative error in the central region. Safe for p ∈ (1e-9, 1 − 1e-9);
 *  outside that we clamp to avoid ±∞ and let the caller handle edge logic. */
export function inverseStandardNormalCdf(p: number): number {
  if (!Number.isFinite(p)) return Number.NaN;
  if (p <= 0) return Number.NEGATIVE_INFINITY;
  if (p >= 1) return Number.POSITIVE_INFINITY;

  // Acklam coefficients.
  const a = [
    -39.69683028665376, 220.9460984245205, -275.9285104469687,
    138.357751867269, -30.66479806614716, 2.506628277459239,
  ];
  const b = [
    -54.47609879822406, 161.5858368580409, -155.6989798598866,
    66.80131188771972, -13.28068155288572,
  ];
  const c = [
    -0.007784894002430293, -0.3223964580411365, -2.400758277161838,
    -2.549732539343734, 4.374664141464968, 2.938163982698783,
  ];
  const d = [
    0.007784695709041462, 0.3224671290700398, 2.445134137142996,
    3.754408661907416,
  ];

  const pLow = 0.02425;
  const pHigh = 1 - pLow;

  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }
  if (p > pHigh) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return (
      -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }
  const q = p - 0.5;
  const r = q * q;
  return (
    ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) *
      q) /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
  );
}

/** Sample skewness γ₃ = E[(x−μ)³] / σ³. Returns 0 when σ=0 OR n<2 (no
 *  meaningful skewness). Uses the biased moment estimator per Bailey/Prado
 *  equation (4) — NOT the bias-corrected G₁ moment used in statistics
 *  textbooks (different normalisation). For DSR consistency this is
 *  correct. */
export function skewness(values: readonly number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  const mean = sum / n;
  let m2 = 0;
  let m3 = 0;
  for (const v of values) {
    const d = v - mean;
    m2 += d * d;
    m3 += d * d * d;
  }
  m2 /= n;
  m3 /= n;
  const sigma = Math.sqrt(m2);
  if (sigma === 0) return 0;
  return m3 / (sigma * sigma * sigma);
}

/** Sample RAW kurtosis γ₄ = E[(x−μ)⁴] / σ⁴ (NOT excess kurtosis; for a
 *  normal distribution this returns 3.0, not 0.0). Bailey/Prado equation
 *  (4) uses raw kurtosis; the DSR denominator formula `(γ₄ − 1) / 4`
 *  expects γ₄ = 3 → (3−1)/4 = 0.5 for a normal-return strategy. */
export function kurtosis(values: readonly number[]): number {
  const n = values.length;
  if (n < 2) return 3; // normal-distribution default
  let sum = 0;
  for (const v of values) sum += v;
  const mean = sum / n;
  let m2 = 0;
  let m4 = 0;
  for (const v of values) {
    const d = v - mean;
    const d2 = d * d;
    m2 += d2;
    m4 += d2 * d2;
  }
  m2 /= n;
  m4 /= n;
  if (m2 === 0) return 3;
  return m4 / (m2 * m2);
}

/** Expected maximum Sharpe of N independent trials drawn from a
 *  distribution with cross-trial standard deviation σ_SR. Bailey/Prado
 *  equation (8):
 *
 *    E[max{SR_k}] ≈ σ_SR × ((1 − γ) × Φ⁻¹(1 − 1/N) + γ × Φ⁻¹(1 − 1/(N·e)))
 *
 *  where γ ≈ 0.5772 is the Euler–Mascheroni constant. Special-cased
 *  for N=1 (no selection bias → 0) and N=2 (Φ⁻¹(0.5) = 0 first term).
 *  For σ_SR = 0 returns 0 (no variance across trials → no selection bias
 *  even with large N). */
export function expectedMaxSharpe(nTrials: number, trialSharpeStd: number): number {
  if (nTrials <= 1 || trialSharpeStd === 0) return 0;
  const term1 = (1 - EULER_MASCHERONI) * inverseStandardNormalCdf(1 - 1 / nTrials);
  const term2 = EULER_MASCHERONI * inverseStandardNormalCdf(1 - 1 / (nTrials * Math.E));
  return trialSharpeStd * (term1 + term2);
}

export interface DeflatedSharpeInput {
  /** Observed Sharpe of the SELECTED strategy. Same unit (per-trade or
   *  annualised) as the returns + nObservations interpretation. */
  observedSharpe: number;
  /** Returns of the selected strategy — per-trade R series. Used to compute
   *  skewness + kurtosis + length T. Must have ≥ 2 entries for meaningful
   *  output; < 2 returns NaN DSR. */
  returns: readonly number[];
  /** Total number of trials in the search family (e.g. 96 Layer B variants,
   *  308 Layer A candidates, 288 Layer B sweep). Used in expected-max-Sharpe
   *  + selection-bias correction. */
  nTrials: number;
  /** Standard deviation of Sharpes across the N trials. Captures how varied
   *  the search family is. Pass 0 if only one trial (no selection bias) OR
   *  if the family Sharpes are all identical (no spread to deflate by). */
  trialSharpeStd: number;
}

export interface DeflatedSharpeResult {
  observedSharpe: number;
  expectedMaxSharpe: number;
  nTrials: number;
  trialSharpeStd: number;
  skewness: number;
  kurtosis: number;
  nObservations: number;
  /** Deflated Sharpe Ratio ∈ [0, 1]. Interpreted as the probability the
   *  observed Sharpe exceeds the null-hypothesis expected-max-Sharpe under
   *  selection bias + non-normality correction. Ship-threshold convention:
   *  DSR ≥ 0.95 (analogous to p ≤ 0.05). */
  deflatedSharpe: number;
  /** Equivalent one-sided p-value = 1 − DSR. Lower is better. */
  pValueOneSided: number;
}

/** Compute the Deflated Sharpe Ratio for a selected strategy.
 *
 *  Bailey/Prado equation (9):
 *    DSR = Φ((SR_obs − SR_0) × √((T − 1) / (1 − γ₃·SR_obs + ((γ₄ − 1)/4)·SR_obs²)))
 *
 *  where SR_0 = E[max{SR_k}] from expectedMaxSharpe(N, σ_SR).
 *
 *  Edge cases:
 *  - T < 2: returns NaN DSR (insufficient sample for skewness/kurtosis).
 *  - Denominator non-positive (extreme kurtosis × high Sharpe interaction):
 *    returns DSR = 0 (correctly conservative — extreme tails should kill DSR).
 *  - SR_obs ≤ SR_0: returns DSR < 0.5 (the observed Sharpe didn't beat
 *    chance-expectation; not "real edge" by any reading).
 */
export function computeDeflatedSharpe(input: DeflatedSharpeInput): DeflatedSharpeResult {
  const { observedSharpe, returns, nTrials, trialSharpeStd } = input;
  const nObservations = returns.length;
  const skew = skewness(returns);
  const kurt = kurtosis(returns);
  const eMaxSR = expectedMaxSharpe(nTrials, trialSharpeStd);

  if (nObservations < 2) {
    return {
      observedSharpe,
      expectedMaxSharpe: eMaxSR,
      nTrials,
      trialSharpeStd,
      skewness: skew,
      kurtosis: kurt,
      nObservations,
      deflatedSharpe: Number.NaN,
      pValueOneSided: Number.NaN,
    };
  }

  // Denominator term per equation (9). For normal returns (skew=0, kurt=3)
  // this reduces to (1 + 0.5·SR²), which is always positive. Pathological
  // combinations (extreme positive skew + extreme high SR) can drive it
  // non-positive — we floor at 0 and treat that as DSR = 0 (the formula
  // breaks down in regions where the asymptotic normality assumption is
  // dubious anyway).
  const denominator =
    1 - skew * observedSharpe + ((kurt - 1) / 4) * observedSharpe * observedSharpe;
  if (denominator <= 0) {
    return {
      observedSharpe,
      expectedMaxSharpe: eMaxSR,
      nTrials,
      trialSharpeStd,
      skewness: skew,
      kurtosis: kurt,
      nObservations,
      deflatedSharpe: 0,
      pValueOneSided: 1,
    };
  }

  const zScore = (observedSharpe - eMaxSR) * Math.sqrt((nObservations - 1) / denominator);
  const dsr = standardNormalCdf(zScore);
  return {
    observedSharpe,
    expectedMaxSharpe: eMaxSR,
    nTrials,
    trialSharpeStd,
    skewness: skew,
    kurtosis: kurt,
    nObservations,
    deflatedSharpe: dsr,
    pValueOneSided: 1 - dsr,
  };
}
