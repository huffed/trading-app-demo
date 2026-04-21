import { z } from "zod";
import { assetClasses } from "./trade";

export const riskLevels = ["conservative", "moderate", "aggressive"] as const;
export const algorithmStatuses = ["draft", "active", "paused", "archived"] as const;

export const algorithmFormSchema = z.object({
  asset_class: z.enum(assetClasses),
  risk_level: z.enum(riskLevels),
  capital: z.coerce.number().positive("Capital must be positive"),
  time_horizon: z.string().min(1, "Time horizon is required"),
  user_hints: z.string().max(500).optional().or(z.literal("")),
});

export type AlgorithmFormValues = z.infer<typeof algorithmFormSchema>;

export const algorithmRulesSchema = z.object({
  entry_conditions: z.array(
    z.object({
      indicator: z.string(),
      operator: z.enum(["less_than", "greater_than", "crosses_above", "crosses_below"]),
      value: z.number(),
      timeframe: z.string(),
    })
  ),
  exit_conditions: z.array(
    z.object({
      indicator: z.string(),
      operator: z.enum(["less_than", "greater_than", "crosses_above", "crosses_below"]),
      value: z.number(),
      timeframe: z.string(),
    })
  ),
  stop_loss: z.object({ type: z.string(), value: z.number() }),
  take_profit: z.object({ type: z.string(), value: z.number() }),
  position_sizing: z.object({ type: z.string(), value: z.number() }),
  max_positions: z.number().int().positive(),
  timeframe: z.string(),
  asset_class: z.string(),
});
