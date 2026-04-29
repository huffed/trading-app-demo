/**
 * Conviction-based position sizing — multiplies the base risk by a factor
 * proportional to how many entry conditions aligned beyond the n_of_m
 * threshold.
 *
 * The friend's discretionary trading showed a clear pattern: 86% WR on
 * his maximum-conviction (2-lot) trades vs 33% on his lowest-conviction
 * (0.2-lot) trades. 70% of his profit came from 18% of his trades —
 * exactly because he sized up when more signals aligned. Encoding that
 * intuition systematically is single biggest P&L lever we identified.
 *
 * Multiplier curve is linear:
 *   k = n     (just barely fires)            → multiplier = 1
 *   k = M     (every condition aligns)       → multiplier = max_multiplier
 *   k between → linear interpolation
 *
 * Falls back to multiplier = 1 (flat risk) when:
 *   - entry_logic is "all" or "any" (no k vs M signal there)
 *   - M == n (no headroom to scale)
 *
 * Default max_multiplier = 4 — meaningfully tighter than the friend's
 * 20× range, so a mis-tuned algorithm can't accidentally blow up on a
 * strong-confluence but still-losing day.
 */
import type { EntryLogic } from "@/types/algorithm";

const DEFAULT_MAX_MULTIPLIER = 4;

/**
 * Compute the conviction multiplier from k (conditions met) and M
 * (total conditions). Pure function — no side effects, easy to unit
 * test against the curve.
 */
export function convictionMultiplier(
  entryLogic: EntryLogic | undefined,
  k: number,
  M: number,
  maxMultiplier: number = DEFAULT_MAX_MULTIPLIER
): number {
  if (typeof entryLogic !== "object" || entryLogic.type !== "n_of_m") {
    return 1;
  }
  const n = entryLogic.n;
  if (M <= n) return 1;
  const aboveMin = Math.max(0, k - n);
  const span = M - n;
  return 1 + (aboveMin / span) * (maxMultiplier - 1);
}

/**
 * Conviction multiplier from cross-timeframe agreement count instead
 * of raw condition count. Used by multi-TF templates where the edge
 * comes from distinct timeframes confirming the same signal — not from
 * stacking redundant conditions on a single timeframe.
 *
 * Empirical anchor: friend-trade multi-TF replay showed ≥2-TF
 * agreement = 61.5% WR vs 33% on single-TF signals (anti-edge).
 *
 * Curve:
 *   firedTfs = 1            → multiplier = 1     (baseline; no boost)
 *   firedTfs = totalTfs     → multiplier = max_multiplier
 *   between                 → linear interpolation
 *
 * Falls back to multiplier = 1 when totalTfs ≤ 1 (single-TF strategy
 * has no agreement signal to scale on; caller should be using the
 * condition-count path instead).
 *
 * Independent of entry_logic — the gate decision stays in checkConditions
 * via n_of_m. This function only sizes a trade that already passed the
 * gate; it never blocks an entry.
 */
export function convictionMultiplierByTfAgreement(
  firedTfs: number,
  totalTfs: number,
  maxMultiplier: number = DEFAULT_MAX_MULTIPLIER
): number {
  if (totalTfs <= 1) return 1;
  const above = Math.max(0, firedTfs - 1);
  const span = totalTfs - 1;
  return 1 + (above / span) * (maxMultiplier - 1);
}
