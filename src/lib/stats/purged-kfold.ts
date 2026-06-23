/**
 * Purged k-fold cross-validation with embargo.
 *
 * López de Prado, M. (2018). Advances in Financial Machine Learning, ch.7.
 * Wiley.
 *
 * Standard k-fold CV leaks information in financial time series:
 *   - Label leakage: a trade's outcome is determined over a window
 *     [entry_date, exit_date]. If a TRAINING trade's outcome window overlaps
 *     the TEST window, training-time information about the test period leaks.
 *   - Forward feature leakage: features computed near the test/train boundary
 *     contain bars that bleed into the test window.
 *
 * Purged k-fold fixes (1) by PURGING training trades whose label-determination
 * window overlaps the test fold's time window. Embargo fixes (2) by EXCLUDING
 * training trades whose entry_date falls within a configurable window
 * IMMEDIATELY AFTER the test fold.
 *
 * Returns one OOS evaluation per fold + aggregate statistics. Ship-criterion
 * per `algo-search.spec.md` §4 criterion 10: ≥ k-1 of k folds produce positive
 * mean R (e.g. 4/5 for k=5). Anything weaker = regime-fragile signal.
 *
 * Used by:
 *   - scripts/canonical/validate-algo.ts (KFOLD env flag → adds purged_kfold sub-block to backtest_results JSONB)
 *   - src/lib/algo-search/criteria.ts (`evaluateDeflatedCriteria`)
 *   - manual ad-hoc evaluation
 */
import type { BacktestTrade } from "@/lib/market-data/types";

export interface PurgedKFoldOptions {
  /** Number of folds. Must be ≥ 2. Default 5. */
  k?: number;
  /** Embargo length as fraction of total time span. Default 0.01 (1%).
   *  For 6yr backtest → ~22 days embargo. Validated < 1/k OR throws (a
   *  larger embargo could remove the entire training set). */
  embargoFraction?: number;
}

export interface FoldResult {
  fold_index: number;
  /** Test window boundaries (ISO date strings). */
  test_start: string;
  test_end: string;
  train_n: number;
  test_n: number;
  train_mean_r: number;
  test_mean_r: number;
  /** Training trades dropped because their [entry, exit] overlapped the test window. */
  purged_count: number;
  /** Training trades dropped because their entry_date fell in the post-test embargo window. */
  embargoed_count: number;
}

export interface PurgedKFoldResult {
  n_folds: number;
  embargo_fraction: number;
  folds: FoldResult[];
  /** Count of folds where test_mean_r > 0. Ship-criterion: ≥ k-1 for clean signal. */
  consistency_count: number;
  /** Mean of fold test_mean_r — a robust OOS R aggregate. */
  oos_mean_r_aggregate: number;
  /** Std of fold test_mean_r — regime-stability indicator. */
  oos_mean_r_std: number;
}

function meanRFor(trades: readonly BacktestTrade[], riskPerTrade: number): number {
  if (trades.length === 0 || riskPerTrade === 0) return 0;
  let sum = 0;
  for (const t of trades) sum += t.pnl / riskPerTrade;
  return sum / trades.length;
}

/** Time-axis split into k equal-duration folds, given sorted trades. Boundaries
 *  derived from the (entry_date min, exit_date max) span of all trades. Returns
 *  per-fold [start_ms, end_ms] tuples. Final fold extends to the absolute max
 *  to absorb any rounding. */
function computeFoldBoundaries(
  trades: readonly BacktestTrade[],
  k: number,
): Array<{ start_ms: number; end_ms: number }> {
  if (trades.length === 0) return [];
  let minMs = Infinity;
  let maxMs = -Infinity;
  for (const t of trades) {
    const e = new Date(t.entry_date).getTime();
    const x = new Date(t.exit_date).getTime();
    if (e < minMs) minMs = e;
    if (x > maxMs) maxMs = x;
  }
  const span = maxMs - minMs;
  const foldDuration = span / k;
  const bounds: Array<{ start_ms: number; end_ms: number }> = [];
  for (let i = 0; i < k; i++) {
    const start = minMs + i * foldDuration;
    const end = i === k - 1 ? maxMs + 1 : minMs + (i + 1) * foldDuration;
    bounds.push({ start_ms: start, end_ms: end });
  }
  return bounds;
}

/** Run purged k-fold CV with embargo. Pure function — no side effects.
 *
 *  Algorithm per López de Prado AFML ch.7.4:
 *    For each fold k (test = fold k, train = all other folds):
 *      1. Identify test trades: entry_date ∈ [test_start, test_end)
 *      2. PURGE training trades: drop any whose [entry_date, exit_date]
 *         window OVERLAPS [test_start, test_end)
 *      3. EMBARGO training trades: drop any whose entry_date falls in
 *         [test_end, test_end + embargo_duration]
 *      4. Compute train/test mean R
 *
 *  Edge handling:
 *    - trades.length < k → some folds may be empty; reported but doesn't throw
 *    - k < 2 → throws (CV requires ≥ 2 folds)
 *    - embargoFraction ≥ 1/k → throws (would drop entire training set)
 *    - riskPerTrade ≤ 0 → throws (R-multiple undefined)
 */
export function purgedKFoldEvaluate(
  trades: readonly BacktestTrade[],
  riskPerTrade: number,
  opts: PurgedKFoldOptions = {},
): PurgedKFoldResult {
  const k = opts.k ?? 5;
  const embargoFraction = opts.embargoFraction ?? 0.01;

  if (k < 2) {
    throw new Error(`purgedKFoldEvaluate requires k ≥ 2; got ${k}.`);
  }
  if (embargoFraction < 0 || embargoFraction >= 1 / k) {
    throw new Error(
      `embargoFraction must be ∈ [0, 1/k=${(1 / k).toFixed(3)}); got ${embargoFraction}. ` +
        `A larger embargo would remove most/all of the training set.`,
    );
  }
  if (riskPerTrade <= 0) {
    throw new Error(`riskPerTrade must be > 0; got ${riskPerTrade}.`);
  }

  // Sort trades by entry_date so fold boundaries are stable.
  const sorted = [...trades].sort(
    (a, b) => new Date(a.entry_date).getTime() - new Date(b.entry_date).getTime(),
  );

  const bounds = computeFoldBoundaries(sorted, k);
  if (bounds.length === 0) {
    return {
      n_folds: k,
      embargo_fraction: embargoFraction,
      folds: [],
      consistency_count: 0,
      oos_mean_r_aggregate: 0,
      oos_mean_r_std: 0,
    };
  }
  const minMs = bounds[0].start_ms;
  const maxMs = bounds[k - 1].end_ms;
  const totalSpan = maxMs - minMs;
  const embargoMs = totalSpan * embargoFraction;

  const folds: FoldResult[] = [];
  for (let i = 0; i < k; i++) {
    const { start_ms, end_ms } = bounds[i];
    const embargoEndMs = end_ms + embargoMs;

    const testTrades: BacktestTrade[] = [];
    const trainCandidate: BacktestTrade[] = [];
    let purgedCount = 0;
    let embargoedCount = 0;

    for (const t of sorted) {
      const entryMs = new Date(t.entry_date).getTime();
      const exitMs = new Date(t.exit_date).getTime();

      // Test set: entry_date in this fold's window.
      if (entryMs >= start_ms && entryMs < end_ms) {
        testTrades.push(t);
        continue;
      }

      // Training-candidate trades start outside this fold. Apply purge + embargo.
      // PURGE: trade's [entry, exit] overlaps test window? (entry < end AND exit > start)
      if (entryMs < end_ms && exitMs > start_ms) {
        purgedCount++;
        continue;
      }
      // EMBARGO: trade's entry falls in post-test embargo window?
      if (entryMs >= end_ms && entryMs < embargoEndMs) {
        embargoedCount++;
        continue;
      }
      // Surviving training trade.
      trainCandidate.push(t);
    }

    folds.push({
      fold_index: i,
      test_start: new Date(start_ms).toISOString(),
      test_end: new Date(end_ms).toISOString(),
      train_n: trainCandidate.length,
      test_n: testTrades.length,
      train_mean_r: meanRFor(trainCandidate, riskPerTrade),
      test_mean_r: meanRFor(testTrades, riskPerTrade),
      purged_count: purgedCount,
      embargoed_count: embargoedCount,
    });
  }

  let consistencyCount = 0;
  let testMeanSum = 0;
  for (const f of folds) {
    if (f.test_mean_r > 0) consistencyCount++;
    testMeanSum += f.test_mean_r;
  }
  const oosMeanAggregate = folds.length > 0 ? testMeanSum / folds.length : 0;

  let varianceSum = 0;
  for (const f of folds) {
    const d = f.test_mean_r - oosMeanAggregate;
    varianceSum += d * d;
  }
  const oosMeanStd = folds.length > 0 ? Math.sqrt(varianceSum / folds.length) : 0;

  return {
    n_folds: k,
    embargo_fraction: embargoFraction,
    folds,
    consistency_count: consistencyCount,
    oos_mean_r_aggregate: oosMeanAggregate,
    oos_mean_r_std: oosMeanStd,
  };
}
