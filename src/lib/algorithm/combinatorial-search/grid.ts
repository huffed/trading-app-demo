/**
 * Curated grid of candidate algorithm rules. Eight strategy templates
 * (5 indicator-based, 3 ICT/SMC pattern-based) crossed with a small
 * set of timeframe / SL-TP / risk variations gives ~50 candidates
 * before pre-budget trimming — enough variety to explore the space
 * meaningfully without exploding the wall-clock budget.
 *
 * Each template is a partial AlgorithmRules with the entry shape and
 * default side; the grid layer fills in the rest (timeframe, SL/TP,
 * sizing, filters, exits) so we don't repeat boilerplate per template.
 *
 * Templates are deliberately conservative on filter mix — every
 * candidate ships with regime_filter + adx_filter + intraday ATR gate
 * (always-on) + stagnant_exit + consistency_rule. The recent shipped
 * gates are wins on every algorithm we've tested; bake them in.
 *
 * Future expansion: when the grid grows past ~80 candidates per run,
 * switch from cartesian enumeration to stratified sampling so the
 * cardinality stays bounded regardless of new templates.
 */
import type {
  AlgorithmRules,
  EntryCondition,
  EntryLogic,
  PatternCondition,
} from "@/types/algorithm";

interface Template {
  name: string;
  /** Entry conditions, parametrised by primary timeframe. The factory
   *  receives the primary tf string and returns the condition list +
   *  entry logic so patterns / indicators that don't fit certain
   *  timeframes can be filtered out per-template. */
  build: (tf: string) => { entry: EntryCondition[]; logic: EntryLogic } | null;
  /** Default trade direction. "auto" means D1 bias decides per-bar. */
  default_side: "long" | "short" | "auto";
  /** Timeframes the template is allowed to run on. Patterns that
   *  reference D1-bias don't make sense on a 4h primary that already
   *  resamples → empty list = "any timeframe". */
  allowed_timeframes?: string[];
}

const TEMPLATES: Template[] = [
  {
    name: "rsi_oversold_bounce",
    default_side: "long",
    build: (tf) => ({
      entry: [
        { type: "technical", indicator: "RSI", operator: "less_than", value: 30, timeframe: tf },
      ],
      logic: "all",
    }),
  },
  {
    name: "rsi_overbought_fade",
    default_side: "short",
    build: (tf) => ({
      entry: [
        { type: "technical", indicator: "RSI", operator: "greater_than", value: 70, timeframe: tf },
      ],
      logic: "all",
    }),
  },
  {
    name: "sma_crossover_trend",
    default_side: "auto",
    build: (tf) => ({
      entry: [
        // value=0 + price-based indicator = "price crosses SMA20".
        // The backtest engine's evalPriceComparison resolves the semantics.
        { type: "technical", indicator: "SMA20", operator: "crosses_above", value: 0, timeframe: tf },
      ],
      logic: "all",
    }),
  },
  {
    name: "ema_macd_signal",
    default_side: "auto",
    build: (tf) => ({
      entry: [
        // EMA12 vs EMA26 — backtest engine handles the MACD-style cross.
        { type: "technical", indicator: "EMA12", operator: "crosses_above", value: 0, timeframe: tf },
      ],
      logic: "all",
    }),
  },
  {
    name: "bollinger_lower_bounce",
    default_side: "long",
    build: (tf) => ({
      entry: [
        {
          type: "technical",
          indicator: "BollingerBands_lower",
          operator: "crosses_above",
          value: 0,
          timeframe: tf,
        },
      ],
      logic: "all",
    }),
  },
  {
    name: "ict_sweep_fvg_combo",
    default_side: "long",
    build: (tf) => buildIctSweepFvg(tf),
    allowed_timeframes: ["1h"],
  },
  {
    name: "ict_bos_orderblock",
    default_side: "long",
    build: (tf) => buildIctBosOrderBlock(tf),
    allowed_timeframes: ["1h"],
  },
  {
    name: "macd_zero_cross",
    default_side: "auto",
    build: (tf) => ({
      entry: [
        { type: "technical", indicator: "MACD", operator: "crosses_above", value: 0, timeframe: tf },
      ],
      logic: "all",
    }),
  },
  // Multi-TF confluence templates — derived from the friend-trade
  // multi-TF replay (scripts/multi-tf-friend-replay.ts). His trades
  // showed 61.5% WR when ≥2 TFs agreed, vs 33% on single-TF signals.
  // Each template requires an explicit cross-TF mix: daily_bias on 1d
  // anchors the bias, then 4h + 1h candle / structure patterns
  // confirm. n_of_m=2 across the {4h, 1h} confirmations replicates
  // the "2-TF agreement" sweet spot.
  {
    name: "multi_tf_engulf_bos",
    default_side: "long",
    build: (tf) => buildMultiTfEngulfBos(tf),
    allowed_timeframes: ["1h"],
  },
  {
    name: "multi_tf_pin_fvg",
    default_side: "long",
    build: (tf) => buildMultiTfPinFvg(tf),
    allowed_timeframes: ["1h"],
  },
  {
    name: "multi_tf_confluence_5",
    default_side: "long",
    build: (tf) => buildMultiTfConfluence5(tf),
    allowed_timeframes: ["1h"],
  },
];

function buildMultiTfEngulfBos(tf: string): { entry: PatternCondition[]; logic: EntryLogic } {
  return {
    entry: [
      { type: "pattern", pattern: "daily_bias", direction: "bullish", ma_period: 20, timeframe: "1d" },
      { type: "pattern", pattern: "engulfing", direction: "bullish", timeframe: "4h" },
      { type: "pattern", pattern: "bos", lookback: 5, direction: "bullish", timeframe: tf },
    ],
    // 2 of 3 — daily_bias as anchor, then either 4h engulfing OR 1h
    // BOS confirms. Catches the friend's "context + intraday trigger"
    // shape without requiring perfect alignment.
    logic: { type: "n_of_m", n: 2 },
  };
}

function buildMultiTfPinFvg(tf: string): { entry: PatternCondition[]; logic: EntryLogic } {
  return {
    entry: [
      { type: "pattern", pattern: "daily_bias", direction: "bullish", ma_period: 20, timeframe: "1d" },
      { type: "pattern", pattern: "pin_bar", direction: "bullish", timeframe: "4h" },
      { type: "pattern", pattern: "fvg", direction: "bullish", timeframe: tf },
    ],
    logic: { type: "n_of_m", n: 2 },
  };
}

function buildMultiTfConfluence5(tf: string): { entry: PatternCondition[]; logic: EntryLogic } {
  return {
    entry: [
      { type: "pattern", pattern: "daily_bias", direction: "bullish", ma_period: 20, timeframe: "1d" },
      { type: "pattern", pattern: "engulfing", direction: "bullish", timeframe: "4h" },
      { type: "pattern", pattern: "pin_bar", direction: "bullish", timeframe: "4h" },
      { type: "pattern", pattern: "bos", lookback: 5, direction: "bullish", timeframe: tf },
      { type: "pattern", pattern: "liquidity_sweep", lookback: 5, direction: "bullish", timeframe: tf },
    ],
    // 3-of-5 — broader confluence across 1d/4h/1h. Higher selectivity
    // than the 2-of-3 templates above; pairs with conviction_scaled
    // sizing to reward 4-or-5-of-5 trades when they appear.
    logic: { type: "n_of_m", n: 3 },
  };
}

function buildIctSweepFvg(tf: string): { entry: PatternCondition[]; logic: EntryLogic } {
  return {
    entry: [
      { type: "pattern", pattern: "daily_bias", direction: "bullish", ma_period: 20, timeframe: "1d" },
      { type: "pattern", pattern: "liquidity_sweep", lookback: 5, direction: "bullish", timeframe: tf },
      { type: "pattern", pattern: "fvg", direction: "bullish", timeframe: tf },
      { type: "pattern", pattern: "ifvg", lookback: 5, direction: "bullish", timeframe: tf },
      { type: "pattern", pattern: "liquidity_sweep", lookback: 5, direction: "bullish", timeframe: "4h" },
    ],
    logic: { type: "n_of_m", n: 2 },
  };
}

function buildIctBosOrderBlock(tf: string): { entry: PatternCondition[]; logic: EntryLogic } {
  return {
    entry: [
      { type: "pattern", pattern: "daily_bias", direction: "bullish", ma_period: 20, timeframe: "1d" },
      { type: "pattern", pattern: "bos", direction: "bullish", timeframe: tf },
      { type: "pattern", pattern: "order_block", direction: "bullish", timeframe: tf },
    ],
    logic: { type: "n_of_m", n: 2 },
  };
}

interface ParameterCombo {
  timeframe: string;
  sl_pct: number;
  tp_pct: number;
  /** Static label for the combo, used to build candidate names. */
  label: string;
}

const PARAMETER_GRID: ParameterCombo[] = [
  // 1h timeframe
  { timeframe: "1h", sl_pct: 0.8, tp_pct: 2.4, label: "1h_tight_3R" },
  { timeframe: "1h", sl_pct: 1.2, tp_pct: 3.6, label: "1h_normal_3R" },
  { timeframe: "1h", sl_pct: 1.5, tp_pct: 4.5, label: "1h_loose_3R" },
  // 4h timeframe — for trend-follow templates that benefit from larger bars
  { timeframe: "4h", sl_pct: 1.5, tp_pct: 4.5, label: "4h_normal_3R" },
];

export interface Candidate {
  /** Stable label for logging and diagnostics. */
  label: string;
  /** Full rule set ready to feed to runWalkForward. */
  rules: AlgorithmRules;
  template_name: string;
}

/**
 * Cartesian product of templates × parameter combos, post-filtered by
 * each template's `allowed_timeframes`. ~30-40 candidates for the
 * default templates; well within the 60-candidate budget.
 */
export function enumerateCandidates(input: {
  capital: number;
  monthly_target_pct: number;
}): Candidate[] {
  const out: Candidate[] = [];
  for (const tmpl of TEMPLATES) {
    for (const combo of PARAMETER_GRID) {
      if (tmpl.allowed_timeframes && !tmpl.allowed_timeframes.includes(combo.timeframe)) {
        continue;
      }
      const built = tmpl.build(combo.timeframe);
      if (!built) continue;
      out.push({
        label: `${tmpl.name}__${combo.label}`,
        template_name: tmpl.name,
        rules: assembleRules(built, combo, tmpl.default_side, input.capital),
      });
    }
  }
  return out;
}

/**
 * Assemble a full AlgorithmRules from the template fragment + parameter
 * combo. Sizing defaults to 0.5% risk_per_trade — a conservative starting
 * point that the scorer can later calibrate against the user's monthly
 * target. All the recent-shipped gates (regime, ADX, intraday ATR,
 * stagnant, consistency) are baked in so candidates are tested against
 * the same gating that runs live.
 */
function assembleRules(
  built: { entry: EntryCondition[]; logic: EntryLogic },
  combo: ParameterCombo,
  side: "long" | "short" | "auto",
  capital: number
): AlgorithmRules {
  const rules: AlgorithmRules = {
    entry_conditions: built.entry,
    entry_logic: built.logic,
    exit_conditions: [],
    stop_loss: { type: "percentage", value: combo.sl_pct },
    take_profit: { type: "percentage", value: combo.tp_pct },
    position_sizing: { type: "risk_per_trade", value: 0.5 },
    max_positions: 5,
    max_per_ticker: 1,
    leverage: 30,
    timeframe: combo.timeframe,
    asset_class: "forex",
    side,
    prop_firm: {
      daily_loss_limit: 5,
      max_drawdown: 10,
      profit_target: 10,
      max_consecutive_losses: 0,
      consecutive_loss_daily_halt: 3,
      consistency_rule: 40,
      slippage_bps: 10,
      commission_pct: 0,
      spread_bps: 5,
    },
    regime_filter: {
      enabled: true,
      atr_period: 20,
      lookback_days: 90,
      percentile_floor: 0.3,
    },
    adx_filter: {
      enabled: true,
      adx_period: 14,
      min_adx: 20,
    },
    stagnant_exit: {
      enabled: true,
      max_bars: 48,
      min_excursion_r: 0.1,
      min_pnl_r: -0.5,
    },
  };
  // Capital is used by some downstream sizing math; the search engine
  // doesn't need it here, but caller passes it through so the rule object
  // is self-contained and ready for `algorithms.insert()` if picked.
  void capital;
  return rules;
}

/**
 * Collect the unique set of timeframes referenced by a candidate batch.
 * Used by the search runner to decide which timeframe-specific price
 * series to pre-load. Cheap; called once per search run.
 */
export function collectCandidateTimeframes(candidates: Candidate[]): string[] {
  const set = new Set<string>();
  for (const c of candidates) {
    set.add(c.rules.timeframe);
    // Pattern conditions reference 1d / 4h higher-tf series; the
    // underlying portfolio backtest auto-resamples those from the
    // primary so the engine doesn't strictly need them pre-fetched,
    // but listing them keeps the price loader honest about coverage.
    for (const cond of c.rules.entry_conditions) {
      if ("timeframe" in cond && cond.timeframe) set.add(cond.timeframe);
    }
  }
  return Array.from(set);
}
