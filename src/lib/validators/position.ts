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

export const entryReasonSchema = z.object({
  conditions_met: z.array(conditionMetSchema),
  signal_result: signalResultSchema.optional(),
});

export type EntryReason = z.infer<typeof entryReasonSchema>;
export type ConditionMet = z.infer<typeof conditionMetSchema>;
