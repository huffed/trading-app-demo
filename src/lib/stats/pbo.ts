/**
 * Probability of Backtest Overfitting (PBO) via Combinatorial Symmetric
 * Cross-Validation (CSCV).
 *
 * Bailey, D.H., Borwein, J.M., López de Prado, M., & Zhu, Q.J. (2014).
 * "The Probability of Backtest Overfitting." Journal of Computational
 * Finance, 20(4):39-69 (preprint earlier). The CSCV procedure measures the
 * probability that the in-sample-best strategy in a trial family is BELOW
 * the median in out-of-sample performance — i.e. the probability that
 * picking by in-sample rank is overfit selection.
 *
 * Algorithm (summary):
 *   1. Split the trial-returns matrix M (T × N: T time periods × N
 *      strategies) into S equal-size submatrices along the time axis.
 *   2. For each combination C of size S/2 chosen from {1..S}:
 *      a. Training set = concat(M_s for s ∈ C); test set = concat(M_s for s ∉ C).
 *      b. Compute Sharpe per strategy on training + test.
 *      c. Find n* = argmax(SR_train) — the in-sample-best strategy.
 *      d. Compute mid-rank of n* among test Sharpes. ω = rank / (N + 1).
 *      e. Logit λ = ln(ω / (1 − ω)).
 *   3. PBO = fraction of combinations where λ ≤ 0 (i.e. n* ranks ≤ median OOS).
 *
 * Interpretation:
 *   - PBO ≈ 0.0 → strong real edge (the in-sample best IS the OOS best, consistently)
 *   - PBO ≈ 0.5 → no signal (in-sample best has random OOS rank — typical for
 *     pure-noise strategy families)
 *   - PBO ≈ 1.0 → severe negative correlation (in-sample best is OOS worst —
 *     synthetic / pathological; rare in practice)
 *
 * Ship-threshold convention used by ROADMAP.md Phase F.5 v3 criterion:
 *   PBO < 0.5 — "more likely real than not."
 *
 * Used by:
 *   - scripts/canonical/algo-search.ts (Phase F.4 re-evaluation; KFOLD path forward)
 *   - src/lib/algo-search/criteria.ts (Phase F.5 v3 criterion)
 *   - manual ad-hoc evaluation
 */

/** Standard Sharpe ratio for a return series (mean / std, no annualisation).
 *  Returns 0 for n < 2 OR zero-variance — treats degenerate samples as
 *  "no signal" rather than NaN to keep downstream arithmetic safe. */
function sharpeRatio(returns: readonly number[], riskFreeRate = 0): number {
  const n = returns.length;
  if (n < 2) return 0;
  let sum = 0;
  for (const r of returns) sum += r;
  const mean = sum / n;
  let m2 = 0;
  for (const r of returns) {
    const d = r - mean;
    m2 += d * d;
  }
  const variance = m2 / n;
  const std = Math.sqrt(variance);
  if (std === 0) return 0;
  return (mean - riskFreeRate) / std;
}

/** Generator over all combinations of size k from {0..n-1}, in lexicographic
 *  order. C(n, k) = n! / (k! * (n-k)!) results. For PBO we use k = n/2 so
 *  C(8,4)=70, C(10,5)=252, C(12,6)=924, C(16,8)=12870. */
function* combinations(n: number, k: number): Generator<number[]> {
  function* recur(start: number, combo: number[]): Generator<number[]> {
    if (combo.length === k) {
      yield combo.slice();
      return;
    }
    const remaining = k - combo.length;
    for (let i = start; i <= n - remaining; i++) {
      combo.push(i);
      yield* recur(i + 1, combo);
      combo.pop();
    }
  }
  yield* recur(0, []);
}

/** Number of combinations C(n, k) = n! / (k!(n-k)!). Computed iteratively
 *  to avoid overflow for moderate n; exact for n ≤ ~30. */
export function nChooseK(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  if (k === 0 || k === n) return 1;
  const kk = Math.min(k, n - k);
  let result = 1;
  for (let i = 0; i < kk; i++) {
    result = (result * (n - i)) / (i + 1);
  }
  return Math.round(result);
}

/** Mid-rank of `targetIdx` within `values` (1-indexed). Ties contribute
 *  half their group size to the rank (standard fractional-rank convention).
 *  For PBO: ω = rank / (N + 1) avoids ω ∈ {0, 1} (which would push the
 *  logit to ±∞). */
function midRank(targetIdx: number, values: readonly number[]): number {
  const target = values[targetIdx];
  let countBelow = 0;
  let countEqual = 0; // includes target itself
  for (let i = 0; i < values.length; i++) {
    if (values[i] < target) countBelow++;
    else if (values[i] === target) countEqual++;
  }
  // Mid-rank treats the tied group as occupying ranks [countBelow+1,
  // countBelow+countEqual] and assigns the target the AVERAGE position.
  return countBelow + (countEqual + 1) / 2;
}

/** Logit transform with edge clipping. ω ∈ (eps, 1-eps) — avoids ±Infinity
 *  for the extreme ranks that occur when N is small. */
function logit(omega: number): number {
  const eps = 1e-10;
  const clipped = Math.min(Math.max(omega, eps), 1 - eps);
  return Math.log(clipped / (1 - clipped));
}

export interface PboInput {
  /** Matrix of strategy returns. `returns[n][t]` = return of strategy n at
   *  time t. All N strategies must have the SAME length T; throws otherwise. */
  returns: readonly (readonly number[])[];
  /** Number of equal-size time-axis submatrices for CSCV. Must be EVEN and
   *  ≥ 4 (CSCV requires C(S, S/2) ≥ 6 combinations for stable PBO estimate).
   *  Default 8 → 70 combinations. Higher = smoother but slower. */
  nSplits?: number;
  /** Per-period risk-free rate subtracted before Sharpe computation.
   *  Default 0 (Sharpe = mean / std of raw returns). */
  riskFreeRate?: number;
}

export interface PboResult {
  /** PBO ∈ [0, 1]. Lower is better. v3 ship-threshold: PBO < 0.5. */
  probabilityOfBacktestOverfitting: number;
  /** C(nSplits, nSplits/2) — number of train/test combinations evaluated. */
  nCombinations: number;
  /** Per-combination logit values. λ ≤ 0 contributes to PBO. */
  logits: number[];
  /** Number of strategies in the trial family. */
  nStrategies: number;
  /** Time periods per strategy. */
  nObservations: number;
  nSplits: number;
}

/** Compute PBO via CSCV. Pure function — no side effects.
 *
 *  Edge handling:
 *   - nStrategies < 2 → throws (can't rank a single strategy)
 *   - nSplits odd OR < 4 → throws (CSCV requires even S ≥ 4)
 *   - T < nSplits → throws (each submatrix needs ≥ 1 observation)
 *   - Row lengths inconsistent → throws (matrix must be rectangular)
 *   - All strategies identical (zero-variance ranking) → PBO = 0.5 by
 *     convention (no signal one way or the other) */
export function computeProbabilityOfBacktestOverfitting(input: PboInput): PboResult {
  const { returns, nSplits = 8, riskFreeRate = 0 } = input;
  const N = returns.length;

  if (N < 2) {
    throw new Error(`PBO requires ≥ 2 strategies; got ${N}.`);
  }
  if (nSplits < 4 || nSplits % 2 !== 0) {
    throw new Error(`PBO nSplits must be even and ≥ 4; got ${nSplits}.`);
  }

  const T = returns[0].length;
  for (let n = 0; n < N; n++) {
    if (returns[n].length !== T) {
      throw new Error(
        `PBO requires rectangular matrix; strategy ${n} has length ${returns[n].length}, expected ${T}.`,
      );
    }
  }
  if (T < nSplits) {
    throw new Error(`PBO requires T ≥ nSplits; got T=${T}, nSplits=${nSplits}.`);
  }

  // Build submatrix boundaries: [start, end) per submatrix.
  const subSize = Math.floor(T / nSplits);
  const subBounds: Array<[number, number]> = [];
  for (let s = 0; s < nSplits; s++) {
    const start = s * subSize;
    const end = s === nSplits - 1 ? T : (s + 1) * subSize;
    subBounds.push([start, end]);
  }

  const halfS = nSplits / 2;
  const logits: number[] = [];
  let countOverfit = 0; // λ ≤ 0
  let totalCombinations = 0;

  // Iterate all C(S, S/2) combinations of training-set submatrix indices.
  for (const trainSubIdx of combinations(nSplits, halfS)) {
    const trainSet = new Set(trainSubIdx);
    // Compute Sharpe per strategy on training + test.
    const srTrain: number[] = new Array(N);
    const srTest: number[] = new Array(N);
    for (let n = 0; n < N; n++) {
      const strategy = returns[n];
      const trainSlice: number[] = [];
      const testSlice: number[] = [];
      for (let s = 0; s < nSplits; s++) {
        const [start, end] = subBounds[s];
        if (trainSet.has(s)) {
          for (let t = start; t < end; t++) trainSlice.push(strategy[t]);
        } else {
          for (let t = start; t < end; t++) testSlice.push(strategy[t]);
        }
      }
      srTrain[n] = sharpeRatio(trainSlice, riskFreeRate);
      srTest[n] = sharpeRatio(testSlice, riskFreeRate);
    }

    // Find in-sample best strategy (ties broken by lower index — deterministic).
    let bestTrainIdx = 0;
    for (let n = 1; n < N; n++) {
      if (srTrain[n] > srTrain[bestTrainIdx]) bestTrainIdx = n;
    }

    // ω = mid-rank of best-train strategy in OOS Sharpes / (N + 1)
    const rank = midRank(bestTrainIdx, srTest);
    const omega = rank / (N + 1);
    const lambda = logit(omega);
    logits.push(lambda);
    if (lambda <= 0) countOverfit++;
    totalCombinations++;
  }

  return {
    probabilityOfBacktestOverfitting: countOverfit / totalCombinations,
    nCombinations: totalCombinations,
    logits,
    nStrategies: N,
    nObservations: T,
    nSplits,
  };
}
