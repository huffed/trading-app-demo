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
  pattern: z.enum([
    "liquidity_sweep",
    "fvg",
    "ifvg",
    "daily_bias",
    "bos",
    "order_block",
    "engulfing",
    "pin_bar",
    "momentum",
    "mean_reversion",
    "gold_session_window",
    "asian_range_break",
    "post_news_window",
  ]),
  direction: z.enum(["bullish", "bearish"]).optional(),
  lookback: z.number().int().min(1).max(100).optional(),
  ma_period: z.number().int().min(1).max(500).optional(),
  // gold_session_window only
  session: z
    .enum(["ny_killzone", "silver_bullet", "london_open", "asian_session"])
    .optional(),
  // post_news_window only — bounds chosen so a 12-hour misconfig fails
  // safely rather than firing for half a trading day.
  min_minutes_after: z.number().int().min(0).max(720).optional(),
  max_minutes_after: z.number().int().min(0).max(720).optional(),
  min_impact: z.enum(["low", "medium", "high"]).optional(),
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
  combined_risk_cap_pct: z.number().min(0.5).max(5).optional(),
  consecutive_loss_unit: z.enum(["trades", "days"]).optional(),
  daily_loss_halt_pct: z.number().min(10).max(100).optional(),
  // 0 = consistency rule disabled (FTMO 2-step path — the live flagship
  // runs 0; the old min(10) floor rejected its own production config).
  consistency_rule: z.union([z.literal(0), z.number().min(10).max(100)]),
  slippage_bps: z.number().min(0).max(100),
  commission_pct: z.number().min(0).max(5),
  spread_bps: z.number().min(0).max(50).optional(),
  // FTMO majors ~$7/lot, gold $7-10/lot. Cap at 50 to allow exotic
  // commission models (e.g. some indices) while flagging a unit error
  // if someone accidentally enters a percentage value here.
  commission_per_lot: z.number().min(0).max(50).optional(),
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

const timeFilterSchema = z.object({
  enabled: z.boolean(),
  // 0-100 with sensible bounds. 45 = "above coin flip" default; tighten
  // as data accumulates. Values < 30 would block almost everything;
  // > 70 require a strong edge that's rare in real algorithms.
  min_wr_pct: z.number().min(20).max(80).optional(),
  // Fewer than 3 samples is statistical noise; more than 50 means the
  // filter never activates on a moderately-active algorithm.
  min_samples: z.number().int().min(3).max(50).optional(),
  // 7-365 days: under a week is too volatile, beyond a year captures
  // regime shifts we'd rather not weight equally.
  window_days: z.number().int().min(7).max(365).optional(),
});

const stagnantExitSchema = z.object({
  enabled: z.boolean(),
  // Bar count override. Bounded so a typo doesn't pin the gate to "never"
  // (huge max_bars) or "instantly" (max_bars = 1). Auto-derive when omitted.
  max_bars: z.number().int().min(2).max(50).optional(),
  // R-units. Range chosen so values like 0.3 / 0.5 / 1.0 all fit but a unit
  // mistake (50 entered for 0.5) gets rejected.
  min_excursion_r: z.number().min(0).max(5).optional(),
  // Allow small positive values for "kill the trade if barely green and
  // stagnant" plays; bound the negative side to one full stop's worth.
  min_pnl_r: z.number().min(-1).max(1).optional(),
});

const trailingStopSchema = z.object({
  enabled: z.boolean(),
  // R-units. 0 = arm immediately at entry (rare; usually want breathing
  // room). 5 = wait for big move before trailing — useful for trend-
  // followers. Default 0.5.
  activate_at_r: z.number().min(0).max(5).optional(),
  // R-units. 0.25 = very tight (locks in fast, exits on noise). 5 = wide
  // trail (lets winners run, gives back more on reversal). Default 1.0.
  trail_distance_r: z.number().min(0.25).max(5).optional(),
});

const driftSchema = z.object({
  // Optional absolute floor on live WR (percent). Drift detector halts
  // when recent WR drops below this regardless of baseline. For R-
  // asymmetric strategies (low WR + high RR), set just below breakeven
  // WR to halt before going negative-EV. Bounds chosen so a unit error
  // (5 entered for 0.05 or 80 entered for breakeven) fails validation.
  min_live_wr_pct: z.number().min(5).max(80).optional(),
});

// Regime-library dormancy gate — values must mirror the unions in
// src/lib/market-data/market-state.ts ("n/a" excluded: unreadable state
// is handled by on_unreadable, never configured as a target state).
const marketStateGateSchema = z.object({
  mode: z.enum(["allow", "block"]),
  states: z.object({
    mtf: z
      .array(
        z.enum([
          "aligned_HH",
          "aligned_LH",
          "ranging_all",
          "fast_div_bull",
          "fast_div_bear",
          "mixed",
        ])
      )
      .optional(),
    vol: z.array(z.enum(["low", "mid", "high"])).optional(),
    range: z.array(z.enum(["compressed", "normal", "expanded"])).optional(),
    dxy: z.array(z.enum(["usd_up", "usd_down", "usd_flip"])).optional(),
  }),
  on_unreadable: z.enum(["block", "allow"]).optional(),
});

const breakevenMoveSchema = z.object({
  enabled: z.boolean(),
  // R-units. 0.5 = aggressive (cuts more recoveries). 3 = lax (breakeven
  // becomes redundant with trailing at high R). Default 1.0.
  trigger_at_r: z.number().min(0.25).max(3).optional(),
});

const dxyFilterSchema = z.object({
  enabled: z.boolean(),
  // Hours: 1h is the smallest sensible window (one bar of the 1h proxy);
  // 72h captures cross-session bias without going so wide the signal
  // averages out. Default 12.
  lookback_hours: z.number().min(1).max(72).optional(),
  // Pips: 1 = effectively no neutral zone; 200 ≈ huge daily DXY swing.
  // Default 15 (the value at which exploratory analysis showed cleanest
  // separation across 4 gold algos).
  pip_threshold: z.number().min(1).max(200).optional(),
  // mode = which bucket(s) to block. See type doc in algorithm.ts for
  // the empirical rationale. Defaults to "block_against" when unset.
  mode: z
    .enum(["block_against", "block_neutral_only", "block_against_and_neutral"])
    .optional(),
  block_neutral: z.boolean().optional(),
});

const llmTraderSchema = z.object({
  enabled: z.boolean(),
  provider: z.enum(["anthropic", "groq"]),
  model: z.string().optional(),
  prompt_version: z.enum(["v1", "v2", "v2_generic", "v2_mtf", "v3", "v4", "v5", "v5_15m"]).optional(),
  dry_run: z.boolean().optional(),
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
  stop_loss: z.object({
    type: z.enum(["percentage", "fixed", "pips", "swing_anchor"]),
    value: z.number(),
    // swing_anchor: lookback range covers very tight (3 bars) through
    // multi-day swing (50 bars); buffer ATR period uses the same bounds
    // as regime/intraday-atr gates for consistency.
    lookback: z.number().int().min(3).max(50).optional(),
    atr_period: z.number().int().min(2).max(200).optional(),
  }),
  take_profit: z.object({
    // prior_day_extreme: TP at the previous UTC day's low (shorts) /
    // high (longs) — the liquidity pool; value = fallback RR when no
    // valid level exists beyond entry.
    type: z.enum(["percentage", "fixed", "pips", "rr_multiple", "prior_day_extreme"]),
    value: z.number(),
  }),
  // Per-side TP override — applied to SHORT entries only (gold's
  // fall-fast-reverse asymmetry: short-geometry screen 2026-06-12,
  // n=134 recorded shorts, rr1.5 +0.38R vs symmetric rr3 +0.26R while
  // longs need rr3; structural-TP screen same day: prior_day_extreme
  // +0.54R). Absent = symmetric take_profit on both sides.
  take_profit_short: z
    .object({
      type: z.enum(["percentage", "fixed", "pips", "rr_multiple", "prior_day_extreme"]),
      value: z.number(),
    })
    .optional(),
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
    z.object({
      type: z.literal("conviction_scaled"),
      // Same bound as risk_per_trade — `value` is the BASE risk before
      // multiplier. Effective max is value × max_multiplier; we trust the
      // multiplier cap to keep peak risk inside FTMO-safe limits.
      value: z
        .number()
        .positive()
        .max(5, "conviction_scaled base risk above 5% is almost certainly a unit error"),
      // Multiplier ceiling. Tighter than the friend's 20× range (0.1→2.0
      // lots) so a mis-tuned algorithm can't accidentally blow up on a
      // strong-confluence but still-losing day.
      max_multiplier: z.number().min(1).max(8).optional(),
      // Conviction signal source. "condition_count" = scale with k-above-n
      // (existing behaviour); "tf_agreement" = scale with distinct
      // timeframes firing (multi-TF templates). See conviction-sizing.ts
      // for the curve.
      conviction_metric: z.enum(["condition_count", "tf_agreement"]).optional(),
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
  stagnant_exit: stagnantExitSchema.optional(),
  trailing_stop: trailingStopSchema.optional(),
  breakeven_move: breakevenMoveSchema.optional(),
  dxy_filter: dxyFilterSchema.optional(),
  llm_trader: llmTraderSchema.optional(),
  time_filter: timeFilterSchema.optional(),
  drift: driftSchema.optional(),
  market_state_gate: marketStateGateSchema.optional(),
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
