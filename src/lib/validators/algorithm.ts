import { z } from "zod";
import { assetClasses } from "./trade";

export const riskLevels = ["conservative", "moderate", "aggressive"] as const;
export const algorithmStatuses = ["draft", "active", "paused", "archived"] as const;

export const algorithmFormSchema = z.object({
  asset_class: z.enum(assetClasses),
  risk_level: z.enum(riskLevels),
  capital: z.coerce.number().positive("Capital must be positive"),
  time_horizon: z.string().min(1, "Time horizon is required"),
  user_hints: z.string().max(2000).optional().or(z.literal("")),
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

export const algorithmRulesSchema = z.object({
  entry_conditions: z.array(normalizedCondition),
  exit_conditions: z.array(normalizedCondition),
  stop_loss: z.object({ type: z.enum(["percentage", "fixed"]), value: z.number() }),
  take_profit: z.object({ type: z.enum(["percentage", "fixed"]), value: z.number() }),
  position_sizing: z.object({
    type: z.enum(["percentage_of_capital", "fixed_amount", "fixed_quantity"]),
    value: z.number(),
  }),
  max_positions: z.number().int().positive(),
  timeframe: z.string(),
  asset_class: z.string(),
  prop_firm: propFirmSchema.optional(),
});
