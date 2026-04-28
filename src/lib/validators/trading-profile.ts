import { z } from "zod";

export const tradingProfileAnswersSchema = z.object({
  goal: z.enum(["grow_savings", "side_income", "learn_trading", "replace_income"]),
  risk_comfort: z.enum(["sleep_well", "some_ups_downs", "high_roller"]),
  capital: z.number().min(50, "Minimum starting capital is $50").max(1_000_000),
  interests: z.array(z.string()).min(1, "Pick at least one interest"),
  time_commitment: z.enum(["set_forget", "check_weekly", "daily_attention"]),
  experience_level: z.enum(["total_beginner", "know_basics", "experienced"]),
  funded_account: z
    .object({
      enabled: z.boolean(),
      preset: z
        .enum(["ftmo", "topstep", "funded_next", "the5ers", "custom"])
        .nullable(),
    })
    .optional(),
});

export const tradingProfileSchema = z.object({
  answers: tradingProfileAnswersSchema,
  derived: z.object({
    asset_class: z.enum(["equity", "crypto", "forex"]),
    risk_level: z.enum(["conservative", "moderate", "aggressive"]),
    time_horizon: z.string(),
    user_hints: z.string(),
  }),
});
