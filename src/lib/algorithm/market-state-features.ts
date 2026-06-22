/**
 * Cohort feature derivers — shared between scan/backtest/cohort-report.
 * Maps raw market context (position-in-range, entry hour) onto the
 * discrete buckets the market-state gate keys on. Extracted from
 * `market-state-gate.ts` on 2026-06-22 (CB.H1 pass 10) so the gate file
 * stays focused on gate evaluation logic.
 */
import type { EntryHourBucket, EntryZone } from "@/types/market-state-gate";

/** Feature-key registry — shared between the gate evaluator and the
 *  shadow-log builder so feature names can't drift between live + audit. */
export const STATE_FEATURE_KEYS = ["mtf", "vol", "range", "dxy"] as const;

/** V1 cluster-mining thresholds (see market-state-gate header). */
export function computeEntryZone(
  positionInRangePct: number | null | undefined
): EntryZone {
  if (positionInRangePct == null) return "n/a";
  if (positionInRangePct < 33) return "discount";
  if (positionInRangePct < 67) return "equilibrium";
  return "premium";
}

export function computeEntryHourBucket(entryHourUtc: number): EntryHourBucket {
  if (entryHourUtc < 7) return "asia(0-7)";
  if (entryHourUtc < 13) return "london(7-13)";
  if (entryHourUtc < 21) return "ny(13-21)";
  return "late(21-24)";
}

/** Compute position-in-range pct as a 20-bar high-low locator. Returns
 *  null when bars are thin (<20) or the window has zero width. Used by
 *  both live and backtest paths to build GateContext for the gate's
 *  entry_zone feature. */
export function computePositionInRangePct(
  bars: { high: number; low: number }[],
  currentPrice: number
): number | null {
  if (bars.length < 20) return null;
  const window = bars.slice(-20);
  let high = -Infinity;
  let low = Infinity;
  for (const b of window) {
    if (b.high > high) high = b.high;
    if (b.low < low) low = b.low;
  }
  if (high <= low) return null;
  const pct = ((currentPrice - low) / (high - low)) * 100;
  return Math.max(0, Math.min(100, pct));
}
