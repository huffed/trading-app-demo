/**
 * H.3 training-row builder + chronological holdout-split helper. Pure
 * functions extracted from scripts/canonical/feature-importance.ts so
 * they can be unit-tested without the Python sidecar / Supabase / FS
 * dependencies of the driver.
 *
 * Label semantic: next-bar-return-sign (1 if next close > current
 * close, else 0). Binary classifier suitable for xgboost.
 */
import { computeAllFeatures, FEATURES, type FeatureContext } from "./index";
import type { PriceBar } from "@/lib/market-data/types";

export interface TrainingRow {
  features: Record<string, number | null>;
  label: 0 | 1;
}

/** Build training rows over `bars`. Skips:
 *   - the last bar (no next-bar return → no label),
 *   - rows where every feature is null (pre-lookback noise),
 *   - rows with broken close values (NaN, non-positive).
 *  Returns `firstValidIdx` = the first bar idx where any feature
 *  computed non-null (so the caller can map row indices back to bar
 *  indices when chronological-splitting). */
export function buildTrainingRows(
  bars: PriceBar[],
  ctx?: FeatureContext,
): { rows: TrainingRow[]; firstValidIdx: number } {
  const rows: TrainingRow[] = [];
  let firstValidIdx = -1;
  for (let i = 0; i < bars.length - 1; i++) {
    const features = computeAllFeatures(FEATURES, bars, i, ctx);
    const allNull = Object.values(features).every((v) => v === null);
    if (allNull) continue;
    if (firstValidIdx < 0) firstValidIdx = i;
    const cur = bars[i].close;
    const next = bars[i + 1].close;
    if (!Number.isFinite(cur) || !Number.isFinite(next) || cur <= 0) continue;
    const label: 0 | 1 = next > cur ? 1 : 0;
    rows.push({ features, label });
  }
  return { rows, firstValidIdx };
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
