/**
 * Cohort attribution + entry_reason composition for openPosition.
 * Extracted from `entry-open.ts` on 2026-06-22 (CB.H1 pass 12) so the
 * cohort math + premium/discount/equilibrium classification + the
 * entry_reason JSONB builder live in a focused module.
 *
 * Cohort fields captured at entry time:
 *  - entry_hour_utc — always set (wall-clock UTC hour)
 *  - position_in_range_pct — 20-bar high-low locator (null when bars <20)
 *  - entry_zone — premium / discount / equilibrium (≥60% / ≤40% / else)
 *  - regime + market_state — caller-provided when available
 *
 * The premium/discount thresholds (60/40) INTENTIONALLY differ from the
 * V1 cluster-mining thresholds (67/33) in market-state-features.ts. The
 * cohort attribution table preserves these older thresholds so historical
 * rows stay interpretable; the gate uses V1 values for cluster matching.
 */
import type { PriceBar } from "@/lib/market-data/types";
import type { SignalResult } from "@/lib/signals/evaluate-live";
import { entryReasonSchema, type EntryCohort } from "@/lib/validators/position";
import type { PatternCondition, TechnicalCondition } from "@/types/algorithm";
import { snapshotCondition } from "./entry-conviction";

/** Compute the cohort fields. Returns a partial — any field that can't be
 *  derived stays absent and Phase 3 slices skip the row. */
export function buildEntryCohort(
  bars: PriceBar[] | undefined,
  currentPrice: number,
  cohortFromCaller: Partial<EntryCohort> | undefined
): Partial<EntryCohort> {
  const cohort: Partial<EntryCohort> = {
    ...(cohortFromCaller ?? {}),
    entry_hour_utc: new Date().getUTCHours(),
  };
  if (bars && bars.length >= 20) {
    const window20 = bars.slice(-20);
    const swingHigh = Math.max(...window20.map((b) => b.high));
    const swingLow = Math.min(...window20.map((b) => b.low));
    if (swingHigh > swingLow) {
      const pct = ((currentPrice - swingLow) / (swingHigh - swingLow)) * 100;
      // Clamp to [0, 100] — currentPrice can drift slightly outside the
      // 20-bar range if the most recent bar made a new high/low.
      cohort.position_in_range_pct = Math.max(0, Math.min(100, pct));
      // Equilibrium band ±10% around 50% midpoint; outside that band is
      // premium (>60%) or discount (<40%). Threshold values picked to
      // match the friend's framing in `feedback_premium_discount_framework.md`.
      cohort.entry_zone =
        cohort.position_in_range_pct >= 60
          ? "premium"
          : cohort.position_in_range_pct <= 40
            ? "discount"
            : "equilibrium";
    }
  }
  return cohort;
}

/** Build the `entry_reason` JSONB by parsing through the Zod schema —
 *  rejects unknown fields + locks the persisted shape against drift. */
export function buildEntryReason(
  conditions: Array<TechnicalCondition | PatternCondition>,
  sentimentResult: SignalResult | undefined,
  cohort: Partial<EntryCohort>
): ReturnType<typeof entryReasonSchema.parse> {
  return entryReasonSchema.parse({
    conditions_met: conditions.map(snapshotCondition),
    signal_result: sentimentResult
      ? {
          signal: sentimentResult.signal,
          confidence: sentimentResult.confidence,
          reasoning: sentimentResult.reasoning,
        }
      : undefined,
    cohort: Object.keys(cohort).length > 0 ? cohort : undefined,
  });
}
