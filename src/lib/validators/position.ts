import { z } from "zod";

export const closePositionSchema = z.object({
  position_id: z.string().uuid("Invalid position ID"),
});

const technicalConditionMetSchema = z.object({
  type: z.literal("technical"),
  indicator: z.string(),
  operator: z.string(),
  value: z.number(),
});

const patternConditionMetSchema = z.object({
  type: z.literal("pattern"),
  pattern: z.string(),
  direction: z.string().nullable().optional(),
  lookback: z.number().nullable().optional(),
  ma_period: z.number().nullable().optional(),
});

const conditionMetSchema = z.discriminatedUnion("type", [
  technicalConditionMetSchema,
  patternConditionMetSchema,
]);

const signalResultSchema = z.object({
  signal: z.string(),
  confidence: z.number(),
  reasoning: z.string(),
});

/**
 * Structured cohort attributes captured at entry time. Foundation for
 * Phase 3 of the architecture rebuild (engine-level cohort gates that
 * auto-skip degrading cohorts). Tracked starting 2026-05-18 so by the
 * time Phase 3 builds, enough cohort-tagged data exists to slice on.
 *
 * All fields optional — older positions and pre-instrumentation rows
 * won't have them. Phase 3 cohort gates must handle null gracefully.
 */
const cohortSchema = z.object({
  /** Regime at entry per D1 read (HH bullish / LH bearish / RANGING). */
  regime: z.enum(["HH", "LH", "RANGING"]).optional(),
  /**
   * Entry trigger family — what kind of setup fired. For LLM-trader
   * entries this is extracted heuristically from the LLM's reasoning
   * (sweep / BOS / pullback / momentum / engulfing / other). For
   * pattern entries it's derived from which condition fired.
   */
  trigger_type: z
    .enum(["sweep", "bos", "pullback", "momentum", "engulfing", "other"])
    .optional(),
  /**
   * Price location within the operative range at entry. Premium = upper
   * half (above 50% of 20-bar range); discount = lower half; equilibrium
   * = near 50%. Per `feedback_premium_discount_framework.md` — long
   * entries in premium and short entries in discount are the high-risk
   * "wrong-zone" cohorts.
   */
  entry_zone: z.enum(["premium", "discount", "equilibrium"]).optional(),
  /**
   * Position-in-range as a percentage (0 = at 20-bar low, 100 = at
   * 20-bar high). Continuous form of entry_zone for finer cohort
   * slicing if Phase 3 needs it.
   */
  position_in_range_pct: z.number().min(0).max(100).optional(),
  /** Entry hour in UTC (0-23). Foundation for hour-of-day cohort
   *  analysis (Asia / EU / NY session edges). */
  entry_hour_utc: z.number().int().min(0).max(23).optional(),
});

export const entryReasonSchema = z.object({
  conditions_met: z.array(conditionMetSchema),
  signal_result: signalResultSchema.optional(),
  cohort: cohortSchema.optional(),
});

export type EntryReason = z.infer<typeof entryReasonSchema>;
export type ConditionMet = z.infer<typeof conditionMetSchema>;
export type EntryCohort = z.infer<typeof cohortSchema>;
