/**
 * H.3 training-row builder + chronological holdout-split helper. Pure
 * functions extracted from scripts/canonical/feature-importance.ts so
 * they can be unit-tested without the Python sidecar / Supabase / FS
 * dependencies of the driver.
 *
 * Label semantic: next-bar-return-sign (1 if next close > current
 * close, else 0). Binary classifier suitable for xgboost.
 */
import type { PriceBar } from "@/lib/market-data/types";
import { nextBarSignLabel, type LabelFn } from "./labels";
import { computeAllFeatures, FEATURES, type FeatureContext } from "./index";

export interface TrainingRow {
  features: Record<string, number | null>;
  label: 0 | 1;
}

/** Result type for `buildTrainingRowsWithIdx` — same as `buildTrainingRows`
 *  plus `bar_indices` so callers using filtered labels (regime-conditioned,
 *  r_aware) can split rows by actual bar date. */
export interface TrainingRowsWithIdx {
  rows: TrainingRow[];
  firstValidIdx: number;
  /** Source bar index for each row in `rows` (same length, same order).
   *  Required by callers that need to map row → bar.date for chronological
   *  splits when label-fn drops bars. */
  bar_indices: number[];
}

/** Build training rows over `bars` with a pluggable label function.
 *  Skips:
 *   - rows where the label is null (label fn returns null → undefined
 *     label; not a 3rd class. Common in r_aware (neither TP nor SL hit
 *     in window) + regime_conditioned (bar not in target regime)),
 *   - rows where every feature is null (pre-lookback noise),
 *   - rows with broken close values (NaN, non-positive).
 *
 *  Default labelFn = `nextBarSignLabel` (H.3 baseline; backwards-compat).
 *  H.4a passes alternative labels via `labelFn` to test whether non-sign
 *  targets carry more discriminable signal (per H.3 FAIL diagnosis).
 *
 *  Returns `firstValidIdx` = the first bar idx where any feature
 *  computed non-null (so the caller can map row indices back to bar
 *  indices when chronological-splitting). */
export function buildTrainingRows(
  bars: PriceBar[],
  ctx?: FeatureContext,
  labelFn: LabelFn = nextBarSignLabel,
): { rows: TrainingRow[]; firstValidIdx: number } {
  const result = buildTrainingRowsWithIdx(bars, ctx, labelFn);
  return { rows: result.rows, firstValidIdx: result.firstValidIdx };
}

/** Same as `buildTrainingRows` but also returns per-row source bar indices.
 *  Required by callers using label functions that drop bars (regime-
 *  conditioned, r_aware): without bar_indices the chronological split via
 *  `findHoldoutCutoff` returns an index based on the original bar count,
 *  which produces wrong cutoffs against the filtered row count. */
export function buildTrainingRowsWithIdx(
  bars: PriceBar[],
  ctx?: FeatureContext,
  labelFn: LabelFn = nextBarSignLabel,
): TrainingRowsWithIdx {
  const rows: TrainingRow[] = [];
  const bar_indices: number[] = [];
  let firstValidIdx = -1;
  for (let i = 0; i < bars.length - 1; i++) {
    const features = computeAllFeatures(FEATURES, bars, i, ctx);
    const allNull = Object.values(features).every((v) => v === null);
    if (allNull) continue;
    if (firstValidIdx < 0) firstValidIdx = i;
    const cur = bars[i].close;
    if (!Number.isFinite(cur) || cur <= 0) continue;
    const label = labelFn(bars, i);
    if (label === null) continue;
    rows.push({ features, label });
    bar_indices.push(i);
  }
  return { rows, firstValidIdx, bar_indices };
}

/** Date-aware cutoff: given filtered `bar_indices` (one per row) + the
 *  original `bars`, return the count of training rows whose source bar
 *  predates the cutoff. Replaces the row-count assumption in
 *  `findHoldoutCutoff` for callers using bar-dropping label functions. */
export function findHoldoutCutoffByDates(
  bars: PriceBar[],
  bar_indices: number[],
  holdoutDays: number,
): number {
  if (bars.length === 0 || bar_indices.length === 0) return 0;
  const lastBarMs = new Date(bars[bars.length - 1].date).getTime();
  const cutoffMs = lastBarMs - holdoutDays * 86_400_000;
  let trainCount = 0;
  for (const idx of bar_indices) {
    if (new Date(bars[idx].date).getTime() < cutoffMs) trainCount++;
    else break; // bar_indices are monotonic by construction
  }
  return trainCount;
}

/** Compute the row index that separates train from holdout, given the
 *  last `holdoutDays` of bars should be the holdout. Returns the count
 *  of training rows (i.e. the cutoff is `rows[0..cutoff)` for train,
 *  `rows[cutoff..]` for holdout).
 *
 *  Degenerate edge cases (caller's min-split guard catches both):
 *    - data span > holdoutDays: clean chronological split at
 *      (lastBar − holdoutDays).
 *    - data span ≤ holdoutDays: every bar falls inside the holdout
 *      window → cutoff=0 (everything is holdout, nothing is train).
 *    - empty bars / negative firstValidIdx: cutoff=0. */
export function findHoldoutCutoff(
  bars: PriceBar[],
  firstValidIdx: number,
  holdoutDays: number,
): number {
  if (bars.length === 0 || firstValidIdx < 0) return 0;
  const lastBarMs = new Date(bars[bars.length - 1].date).getTime();
  const cutoffMs = lastBarMs - holdoutDays * 86_400_000;
  for (let i = firstValidIdx; i < bars.length - 1; i++) {
    if (new Date(bars[i].date).getTime() >= cutoffMs) {
      let rowCount = 0;
      for (let j = firstValidIdx; j < i; j++) {
        if (j >= bars.length - 1) break;
        const cur = bars[j].close;
        const next = bars[j + 1].close;
        if (!Number.isFinite(cur) || !Number.isFinite(next) || cur <= 0) continue;
        rowCount++;
      }
      return rowCount;
    }
  }
  // Unreachable in practice: lastBar.date is always ≥ cutoffMs by
  // construction (cutoffMs = lastBar − holdoutDays). Defensive return.
  return 0;
}
