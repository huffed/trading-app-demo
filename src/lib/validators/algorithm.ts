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

// Loose form-side news_veto schema — UI sends strings, this coerces them.
const newsVetoInput = z
  .object({
    enabled: z.coerce.boolean(),
    block_minutes_before: z.coerce.number().int().min(0).max(180),
    block_minutes_after: z.coerce.number().int().min(0).max(180),
    min_impact: z.enum(["low", "medium", "high"]),
  })
  .optional();

// Loose form-side prop-firm input — strings from inputs get coerced.
const propFirmInput = z
  .object({
    daily_loss_limit: z.coerce.number(),
    max_drawdown: z.coerce.number(),
    profit_target: z.coerce.number(),
    max_consecutive_losses: z.coerce.number().int().min(0),
    consecutive_loss_unit: z.enum(["trades", "days"]).optional(),
    daily_loss_halt_pct: z.coerce.number().min(10).max(100).optional(),
    consistency_rule: z.coerce.number(),
    slippage_bps: z.coerce.number(),
    commission_pct: z.coerce.number(),
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

const patternConditionSchema = z.object({
  type: z.literal("pattern"),
  pattern: z.enum(["liquidity_sweep", "fvg", "ifvg", "daily_bias", "bos", "order_block"]),
  direction: z.enum(["bullish", "bearish"]).optional(),
  lookback: z.number().int().min(1).max(100).optional(),
  ma_period: z.number().int().min(1).max(500).optional(),
  timeframe: z.string(),
});

const conditionSchema = z.discriminatedUnion("type", [
  technicalConditionSchema,
  sentimentConditionSchema,
  patternConditionSchema,
]);

// Legacy conditions (no `type` field) are normalized to "technical"
const normalizedCondition = z.preprocess((val) => {
  if (typeof val === "object" && val !== null && !("type" in val)) {
    return { ...val, type: "technical" };
  }
  return val;
}, conditionSchema);

export const propFirmRulesSchema = z.object({
  daily_loss_limit: z.number().min(0.5).max(20),
  max_drawdown: z.number().min(1).max(30),
  profit_target: z.number().min(1).max(50),
  // 0 disables the kill switch entirely.
  max_consecutive_losses: z.number().int().min(0).max(50),
  consecutive_loss_daily_halt: z.number().int().min(0).max(20).optional(),
  consecutive_loss_unit: z.enum(["trades", "days"]).optional(),
  daily_loss_halt_pct: z.number().min(10).max(100).optional(),
  consistency_rule: z.number().min(10).max(100),
  slippage_bps: z.number().min(0).max(100),
  commission_pct: z.number().min(0).max(5),
  spread_bps: z.number().min(0).max(50).optional(),
});

const newsVetoSchema = z.object({
  enabled: z.boolean(),
  block_minutes_before: z.number().int().min(0).max(180),
  block_minutes_after: z.number().int().min(0).max(180),
  min_impact: z.enum(["low", "medium", "high"]),
});

const divergenceKillSchema = z.object({
  max_avg_bps: z.number().min(1).max(500),
  window_trades: z.number().int().min(2).max(200),
});

const regimeFilterSchema = z.object({
  enabled: z.boolean(),
  atr_period: z.number().int().min(2).max(200).optional(),
  lookback_days: z.number().int().min(20).max(500).optional(),
  percentile_floor: z.number().min(0).max(1).optional(),
});

const adxFilterSchema = z.object({
  enabled: z.boolean(),
  adx_period: z.number().int().min(5).max(100).optional(),
  min_adx: z.number().min(0).max(100).optional(),
});

const entryLogicSchema = z.union([
  z.literal("all"),
  z.literal("any"),
  z.object({ type: z.literal("n_of_m"), n: z.number().int().positive() }),
]);

export const algorithmStatusSchema = z.enum(["draft", "active", "paused", "archived"]);

export const algorithmRulesSchema = z.object({
  entry_conditions: z.array(normalizedCondition),
  entry_logic: entryLogicSchema.optional(),
  exit_conditions: z.array(normalizedCondition),
  exit_logic: entryLogicSchema.optional(),
  stop_loss: z.object({ type: z.enum(["percentage", "fixed", "pips"]), value: z.number() }),
  take_profit: z.object({ type: z.enum(["percentage", "fixed", "pips"]), value: z.number() }),
  // Per-type sizing bounds. Catches the "stale form sends 70 thinking
  // it's 0.7" class of bug — clampRules can't safely rescue a literal
  // user-submitted value, so reject upstream instead. Numbers chosen so
  // legitimate aggressive configs still pass:
  //   - percentage_of_capital: 100% is the structural ceiling
  //   - risk_per_trade: 5% is well above any sane prop-firm strategy
  //     (FTMO blew up at 0.7-1%; "aggressive retail" caps at ~2%)
  //   - lots: FTMO MT5 caps at 50, retail brokers similar
  //   - fixed_amount / fixed_quantity: bounded by context, not generic
  position_sizing: z.discriminatedUnion("type", [
    z.object({
      type: z.literal("percentage_of_capital"),
      value: z.number().positive().max(100, "percentage_of_capital cannot exceed 100"),
    }),
    z.object({
      type: z.literal("fixed_amount"),
      value: z.number().positive(),
    }),
    z.object({
      type: z.literal("fixed_quantity"),
      value: z.number().positive(),
    }),
    z.object({
      type: z.literal("lots"),
      value: z.number().positive().max(50, "lots above 50 — broker caps would reject"),
    }),
    z.object({
      type: z.literal("risk_per_trade"),
      value: z
        .number()
        .positive()
        .max(5, "risk_per_trade above 5% is almost certainly a unit error (e.g. 70 entered for 0.7)"),
    }),
  ]),
  max_positions: z.number().int().positive(),
  max_per_ticker: z.number().int().positive().optional(),
  leverage: z.number().int().min(1).max(500).optional(),
  timeframe: z.string(),
  asset_class: z.string(),
  side: z.enum(["long", "short", "auto"]).optional(),
  prop_firm: propFirmRulesSchema.optional(),
  news_veto: newsVetoSchema.optional(),
  divergence_kill: divergenceKillSchema.optional(),
  regime_filter: regimeFilterSchema.optional(),
  adx_filter: adxFilterSchema.optional(),
});

/**
 * Validates the payload accepted by `updateAlgorithm`. Top-level fields are
 * optional (any subset can be patched) but `rules`, when present, must be a
 * complete rule set — partial rule updates are rejected because the
 * downstream backtest/scan engines assume every required field is set.
 */
export const algorithmUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  status: algorithmStatusSchema.optional(),
  rules: algorithmRulesSchema.optional(),
  live_trading_enabled: z.boolean().optional(),
  broker_connection_id: z.string().uuid().nullable().optional(),
});

export type AlgorithmUpdate = z.infer<typeof algorithmUpdateSchema>;
