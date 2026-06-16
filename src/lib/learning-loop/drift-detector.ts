/**
 * Drift detector — the learning loop's input-side signal (issue #218).
 *
 * Detects when the current market-state distribution has drifted away
 * from the algo's calibration distribution. Operates on per-bar state
 * observations (from `computeMarketState4h`) rather than on trade
 * outcomes — sample size scales with bars, not trades, so sparse-trade
 * algos still get a high-resolution signal.
 *
 * Pre-registered (do NOT edit post-hoc per
 * feedback_audit_proposals_rigorously_before_presenting +
 * feedback_drift_not_losses):
 *
 *   DRIFT rule:
 *     - For each state dimension (mtf, vol, range, dxy), compute the
 *       bucket-proportion histogram over baseline and recent windows.
 *     - max(|baseline_pct - recent_pct|) across all dimensions × buckets
 *     - Flag drift if max ≥ 15 percentage points.
 *
 *   RECOVERY rule (hysteresis):
 *     - max shift falls back below 8 percentage points → drift resolved.
 *
 *   WINDOW:
 *     - Baseline: full calibration period (algo-specific).
 *     - Recent: last 14 days of bar observations.
 *     - "n/a" buckets are counted — they represent legitimate "feature
 *       unreadable" states (e.g. EUR/USD history floor before Aug 2025)
 *       and should not be silently dropped.
 *
 * If empirical Level A meta-backtest shows these thresholds need to
 * change, ship a follow-on PR with NEW pre-registered values. Editing
 * in-place curve-fits the experiment.
 */
import type { MarketState } from "../market-data/market-state";

export type StateBucket = Record<string, number>;

export interface StateDistribution {
  mtf: StateBucket;
  vol: StateBucket;
  range: StateBucket;
  dxy: StateBucket;
  /** Total observations across all dimensions (each bar contributes 1
   *  observation per dimension, so total = states.length). */
  total: number;
}

export const DRIFT_DIMENSIONS = ["mtf", "vol", "range", "dxy"] as const;
export type DriftDimension = (typeof DRIFT_DIMENSIONS)[number];

export const DEFAULT_DRIFT_THRESHOLD_PP = 15;
export const DEFAULT_RECOVERY_THRESHOLD_PP = 8;
export const DEFAULT_RECENT_WINDOW_DAYS = 14;

/** Aggregate a list of MarketState observations into the bucket-count
 *  distribution. Bar-observation-count for each dimension equals
 *  `total`, including "n/a" buckets. */
export function buildDistribution(states: MarketState[]): StateDistribution {
  const dist: StateDistribution = {
    mtf: {},
    vol: {},
    range: {},
    dxy: {},
    total: states.length,
  };
  for (const s of states) {
    for (const dim of DRIFT_DIMENSIONS) {
      const bucket = s[dim];
      dist[dim][bucket] = (dist[dim][bucket] ?? 0) + 1;
    }
  }
  return dist;
}

export interface DriftShift {
  dimension: DriftDimension;
  bucket: string;
  baselinePct: number;
  recentPct: number;
  shiftPp: number;
}

export interface DriftVerdict {
  flagged: boolean;
  reason?: string;
  /** The maximum-shift bucket across all dimensions × buckets. */
  maxShift: DriftShift | null;
  /** All shifts, sorted by absolute shift descending. Useful for
   *  diagnostic output and for hysteresis on the recovery path. */
  allShifts: DriftShift[];
}

function pct(bucket: StateBucket, total: number, key: string): number {
  if (total <= 0) return 0;
  return ((bucket[key] ?? 0) / total) * 100;
}

/** Compute max absolute proportion shift across all
 *  dimensions × buckets present in either distribution. Returns the
 *  full sorted-by-magnitude list plus the max for convenience. */
function computeShifts(
  baseline: StateDistribution,
  recent: StateDistribution
): DriftShift[] {
  const shifts: DriftShift[] = [];
  for (const dim of DRIFT_DIMENSIONS) {
    const keys = new Set([
      ...Object.keys(baseline[dim]),
      ...Object.keys(recent[dim]),
    ]);
    for (const key of keys) {
      const bp = pct(baseline[dim], baseline.total, key);
      const rp = pct(recent[dim], recent.total, key);
      shifts.push({
        dimension: dim,
        bucket: key,
        baselinePct: bp,
        recentPct: rp,
        shiftPp: Math.abs(rp - bp),
      });
    }
  }
  shifts.sort((a, b) => b.shiftPp - a.shiftPp);
  return shifts;
}

export interface DriftCheckOptions {
  baseline: StateDistribution;
  recent: StateDistribution;
  /** Min total observations in `recent` for a verdict — guards against
   *  one-bar windows triggering noise. Default 30. */
  minRecentObservations?: number;
  driftThresholdPp?: number;
}

export function detectDrift(opts: DriftCheckOptions): DriftVerdict {
  const minObs = opts.minRecentObservations ?? 30;
  const threshold = opts.driftThresholdPp ?? DEFAULT_DRIFT_THRESHOLD_PP;

  if (opts.recent.total < minObs) {
    return {
      flagged: false,
      reason: `insufficient recent observations (${opts.recent.total} < ${minObs})`,
      maxShift: null,
      allShifts: [],
    };
  }
  if (opts.baseline.total < minObs) {
    return {
      flagged: false,
      reason: `insufficient baseline observations (${opts.baseline.total} < ${minObs})`,
      maxShift: null,
      allShifts: [],
    };
  }

  const shifts = computeShifts(opts.baseline, opts.recent);
  const maxShift = shifts[0] ?? null;
  if (maxShift && maxShift.shiftPp >= threshold) {
    return {
      flagged: true,
      reason: `${maxShift.dimension}.${maxShift.bucket} ${maxShift.baselinePct.toFixed(0)}%→${maxShift.recentPct.toFixed(0)}% (Δ=${maxShift.shiftPp.toFixed(0)}pp ≥ ${threshold}pp)`,
      maxShift,
      allShifts: shifts,
    };
  }
  return { flagged: false, maxShift, allShifts: shifts };
}

export interface DriftRecoveryVerdict {
  recovered: boolean;
  reason?: string;
  maxShift: DriftShift | null;
}

export interface DriftRecoveryCheckOptions {
  baseline: StateDistribution;
  recent: StateDistribution;
  minRecentObservations?: number;
  recoveryThresholdPp?: number;
}

/** Drift has recovered when the max bucket shift falls below the
 *  recovery threshold (hysteresis vs the drift threshold prevents
 *  flapping). */
export function detectDriftRecovery(
  opts: DriftRecoveryCheckOptions
): DriftRecoveryVerdict {
  const minObs = opts.minRecentObservations ?? 30;
  const threshold = opts.recoveryThresholdPp ?? DEFAULT_RECOVERY_THRESHOLD_PP;

  if (opts.recent.total < minObs || opts.baseline.total < minObs) {
    return {
      recovered: false,
      reason: `insufficient observations (recent=${opts.recent.total}, baseline=${opts.baseline.total})`,
      maxShift: null,
    };
  }
  const shifts = computeShifts(opts.baseline, opts.recent);
  const maxShift = shifts[0] ?? null;
  if (!maxShift) return { recovered: false, maxShift: null };
  if (maxShift.shiftPp < threshold) {
    return {
      recovered: true,
      reason: `max shift ${maxShift.shiftPp.toFixed(0)}pp < ${threshold}pp threshold`,
      maxShift,
    };
  }
  return { recovered: false, maxShift };
}
