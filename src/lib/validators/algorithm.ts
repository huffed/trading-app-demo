import { z } from "zod";
import { assetClasses } from "./trade";

export const riskLevels = ["conservative", "moderate", "aggressive"] as const;
export const algorithmStatuses = ["draft", "active", "paused", "archived"] as const;

// Optional manual overrides — when set, applied on top of the AI's generated
// rules so power users can lock in exact values without giving up the AI's
// condition selection.
const overridesSchema = z
  .object({
    stop_loss: z.coerce.number().positive().optional(),
    take_profit: z.coerce.number().positive().optional(),
    position_size: z.coerce.number().positive().optional(),
    max_positions: z.coerce.number().int().positive().optional(),
    max_per_ticker: z.coerce.number().int().positive().optional(),
  })
  .optional();

// Forward-declared so it can be reused in algorithmFormSchema before the
// detailed propFirmSchema appears further down. Kept loose at parse time
// (the strict schema below validates ranges).
const propFirmInput = z
  .object({
    daily_loss_limit: z.coerce.number(),
    max_drawdown: z.coerce.number(),
    profit_target: z.coerce.number(),
    max_consecutive_losses: z.coerce.number().int(),
    consistency_rule: z.coerce.number(),
    slippage_bps: z.coerce.number(),
    commission_pct: z.coerce.number(),
  })
  .optional();

// Loose form-side news_veto schema — UI sends strings, this coerces them.
const newsVetoInput = z
  .object({
    enabled: z.coerce.boolean(),
    block_minutes_before: z.coerce.number().int().min(0).max(180),
    block_minutes_after: z.coerce.number().int().min(0).max(180),
    min_impact: z.enum(["low", "medium", "high"]),
  })
  .optional();

export const algorithmFormSchema = z.object({
  name: z.string().trim().max(80).optional().or(z.literal("")),
  asset_class: z.enum(assetClasses),
  risk_level: z.enum(riskLevels),
  capital: z.coerce.number().positive("Capital must be positive"),
  time_horizon: z.string().min(1, "Time horizon is required"),
  user_hints: z.string().max(2000).optional().or(z.literal("")),
  overrides: overridesSchema,
  prop_firm: propFirmInput,
  news_veto: newsVetoInput,
});

export type AlgorithmFormValues = z.infer<typeof algorithmFormSchema>;

// --- Condition schemas (discriminated union) ---

const technicalConditionSchema = z.object({
  type: z.literal("technical"),
  indicator: z.string(),
  operator: z.enum(["less_than", "greater_than", "crosses_above", "crosses_below"]),
  value: z.number(),
  timeframe: z.string(),
});

const sentimentConditionSchema = z.object({
  type: z.literal("sentiment"),
  source: z.enum(["news", "social"]),
  metric: z.string(),
  operator: z.enum(["above", "below", "spike_above", "spike_below"]),
  threshold: z.number(),
  topics: z.array(z.string()).optional(),
  tickers: z.array(z.string()).optional(),
  timeframe: z.string(),
});

const conditionSchema = z.discriminatedUnion("type", [
  technicalConditionSchema,
  sentimentConditionSchema,
]);

// Legacy conditions (no `type` field) are normalized to "technical"
const normalizedCondition = z.preprocess((val) => {
  if (typeof val === "object" && val !== null && !("type" in val)) {
    return { ...val, type: "technical" };
  }
  return val;
}, conditionSchema);

const propFirmSchema = z.object({
  daily_loss_limit: z.number().min(0.5).max(20),
  max_drawdown: z.number().min(1).max(30),
  profit_target: z.number().min(1).max(50),
  max_consecutive_losses: z.number().int().min(1).max(20),
  consistency_rule: z.number().min(10).max(100),
  slippage_bps: z.number().min(0).max(100),
  commission_pct: z.number().min(0).max(5),
});

const newsVetoSchema = z.object({
  enabled: z.boolean(),
  block_minutes_before: z.number().int().min(0).max(180),
  block_minutes_after: z.number().int().min(0).max(180),
  min_impact: z.enum(["low", "medium", "high"]),
});

const entryLogicSchema = z.union([
  z.literal("all"),
  z.literal("any"),
  z.object({ type: z.literal("n_of_m"), n: z.number().int().positive() }),
]);

export const algorithmRulesSchema = z.object({
  entry_conditions: z.array(normalizedCondition),
  entry_logic: entryLogicSchema.optional(),
  exit_conditions: z.array(normalizedCondition),
  stop_loss: z.object({ type: z.enum(["percentage", "fixed"]), value: z.number() }),
  take_profit: z.object({ type: z.enum(["percentage", "fixed"]), value: z.number() }),
  position_sizing: z.object({
    type: z.enum(["percentage_of_capital", "fixed_amount", "fixed_quantity"]),
    value: z.number(),
  }),
  max_positions: z.number().int().positive(),
  max_per_ticker: z.number().int().positive().optional(),
  timeframe: z.string(),
  asset_class: z.string(),
  prop_firm: propFirmSchema.optional(),
  news_veto: newsVetoSchema.optional(),
});
