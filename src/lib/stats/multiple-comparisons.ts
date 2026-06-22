/** Multiple-comparisons correction (Bonferroni + bootstrap p-values).
 *
 *  When we evaluate N candidate algorithms or N walk-forward windows,
 *  the family-wise probability of declaring a chance result "significant"
 *  inflates with N. Bonferroni controls this by tightening per-test
 *  alpha to family_alpha / N.
 *
 *  Concrete use case: Phase B.2 validator runs ~15 candidate algos and
 *  asks each "is mean R > 0 at 5% significance?" Without correction,
 *  expected false-positive count = 15 × 0.05 = 0.75 algos per run.
 *  Bonferroni: corrected per-algo alpha = 0.05/15 ≈ 0.0033 — each algo
 *  must clear a much tighter bar. */

/** Bonferroni-adjusted per-test alpha. */
export function bonferroniAlpha(familyAlpha: number, nTests: number): number {
  if (nTests <= 0) return familyAlpha;
  return familyAlpha / nTests;
}

/** Does a single test pass at Bonferroni-corrected significance? */
export function passesAtBonferroni(pValue: number, familyAlpha: number, nTests: number): boolean {
  return pValue < bonferroniAlpha(familyAlpha, nTests);
}

/** Bootstrap p-value for "true mean > 0" (one-sided).
 *
 *  Given resampled statistic distribution, p = fraction of resamples
 *  with stat ≤ 0. Small p → most resamples positive → evidence the true
 *  mean is > 0. Use against family-wise alpha (corrected via Bonferroni)
 *  to decide ship/no-ship.
 *
 *  B.2.23 (Stage 3, 2026-06-19 EVE): use mid-rank corrected estimator
 *  `(count + 0.5) / (N + 1)` (Davison & Hinkley 1997, §4.4.2) instead of
 *  the `Math.max(count/N, 1/(N+1))` floor-clamp. The clamp was
 *  systematically upward-biased near p=0 (count=0 → 1/(N+1) which is
 *  ~2× the unbiased value). Mid-rank correction:
 *    - count=0:    0.5/(N+1)        (was 1/(N+1) — 2× tighter)
 *    - count=N:    (N+0.5)/(N+1)    (was N/N=1)
 *    - count=k:    (k+0.5)/(N+1)    (was k/N — slight shift)
 *  Smoother, less integer-jumpy, conservative-enough for ship/no-ship.
 *  Returns p in (0, 1) — strictly positive (no log(0) downstream). */
function midRankP(count: number, total: number): number {
  if (total <= 0) return 1;
  return (count + 0.5) / (total + 1);
}

export function bootstrapPValueGtZero(samples: number[]): number {
  if (samples.length === 0) return 1;
  let nonPositive = 0;
  for (const s of samples) if (s <= 0) nonPositive++;
  return midRankP(nonPositive, samples.length);
}

/** Bootstrap p-value for "true mean < 0" (one-sided, the dangerous direction). */
export function bootstrapPValueLtZero(samples: number[]): number {
  if (samples.length === 0) return 1;
  let nonNegative = 0;
  for (const s of samples) if (s >= 0) nonNegative++;
  return midRankP(nonNegative, samples.length);
}

/** Two-sided bootstrap p-value for "true mean ≠ 0". */
export function bootstrapPValueTwoSided(samples: number[]): number {
  const oneSidedGt = bootstrapPValueGtZero(samples);
  const oneSidedLt = bootstrapPValueLtZero(samples);
  return Math.min(2 * Math.min(oneSidedGt, oneSidedLt), 1);
}

export interface MccVerdict {
  p_value: number;
  bonferroni_alpha: number;
  passes: boolean;
  family_alpha: number;
  n_tests: number;
}

/** One-shot helper: compute p-value from bootstrap samples and judge it
 *  against Bonferroni-corrected family alpha. Returns the verdict object
 *  consumed by validate-algo.ts result rows. */
export function bonferroniVerdict(
  bootstrapSamples: number[],
  familyAlpha: number,
  nTests: number
): MccVerdict {
  const pValue = bootstrapPValueGtZero(bootstrapSamples);
  const alpha = bonferroniAlpha(familyAlpha, nTests);
  return {
    p_value: pValue,
    bonferroni_alpha: alpha,
    passes: pValue < alpha,
    family_alpha: familyAlpha,
    n_tests: nTests,
  };
}
