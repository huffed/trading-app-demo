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
import { EXIT_VARIANTS } from "./exit-variants";

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
  /** When true, the grid emits an additional candidate per parameter
   *  combo with `conviction_scaled + tf_agreement` sizing. Only useful
   *  for templates with conditions spanning ≥2 timeframes — single-TF
   *  templates have no agreement signal to scale on. */
  include_tf_conviction_variant?: boolean;
}

// Template order matters: candidates are enumerated in this order and
// the search runner caps to `max_candidates`. The data-validated
// (replay-confirmed) templates go first — momentum first because it
// cleared 44.7% hit / 76.5% WR against the friend's actual FTMO
// trades, then multi_tf, then ICT, then bare indicators.
const TEMPLATES: Template[] = [
  // Momentum continuation templates — derived from the direction-split
  // feature dump (scripts/feature-dump-friend-trades.ts). Solo 1h
  // momentum cleared 44.7% hit rate / 76.5% WR against the friend's
  // FTMO trades — the first template to clear the 30% clone-claim
  // threshold AND beat his 58% baseline. The d1_bias + momentum 2-of-2
  // variant is also enumerated so walk-forward decides whether the
  // bias filter helps or hurts on out-of-sample data.
  //
  // Both directions: feature dump showed momentum continuation works
  // for longs AND shorts (long wins +0.18 ATR median, short wins
  // -0.72 ATR median). Default side stays long here — search engine
  // can produce a short variant separately, and `auto` routing depends
  // on D1 bias which the solo template intentionally omits.
  {
    name: "momentum_solo",
    default_side: "long",
    build: (tf) => ({
      entry: [
        { type: "pattern", pattern: "momentum", direction: "bullish", lookback: 3, timeframe: tf },
      ],
      logic: "all",
    }),
    allowed_timeframes: ["1h", "4h"],
  },
  {
    name: "momentum_with_bias",
    default_side: "long",
    build: (tf) => ({
      entry: [
        { type: "pattern", pattern: "daily_bias", direction: "bullish", ma_period: 20, timeframe: "1d" },
        { type: "pattern", pattern: "momentum", direction: "bullish", lookback: 3, timeframe: tf },
      ],
      // 2-of-2 — both must fire. Stricter filter; lower hit rate
      // against the friend's data but cleaner trend alignment.
      logic: { type: "n_of_m", n: 2 },
    }),
    allowed_timeframes: ["1h"],
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
    include_tf_conviction_variant: true,
  },
  {
    name: "multi_tf_pin_fvg",
    default_side: "long",
    build: (tf) => buildMultiTfPinFvg(tf),
    allowed_timeframes: ["1h"],
    include_tf_conviction_variant: true,
  },
  {
    name: "multi_tf_confluence_5",
    default_side: "long",
    build: (tf) => buildMultiTfConfluence5(tf),
    allowed_timeframes: ["1h"],
    include_tf_conviction_variant: true,
  },
  // ICT/SMC templates — older single-TF pattern combos. Kept in the
  // grid because they sometimes still win walk-forward on specific
  // SL/TP combos, but ranked below the data-validated templates above.
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
  // Gold-specific templates — research-anchored seeds for the XAU/USD
  // workstream (see `docs/gold-trading-workstream.md`). Each uses at
  // least one gold-scoped primitive (gold_session_window,
  // asian_range_break, post_news_window) or a gold-tuned indicator combo
  // (SMA200 trend filter). Listed after multi-TF/ICT but before bare
  // indicators so they're prioritised on a gold-restricted search but
  // can still get cut on a generic forex search.
  //
  // The session-window carve-out is data-justified per
  // `feedback_data_driven_gates`: PR-3 will run the dual-run validator
  // on each gold candidate to confirm the filter adds measurable edge.
  {
    name: "gold_killzone_sweep",
    default_side: "long",
    build: (tf) => ({
      entry: [
        // NY Killzone time gate — institutional flow window 11-15 UTC.
        { type: "pattern", pattern: "gold_session_window", session: "ny_killzone", timeframe: tf },
        { type: "pattern", pattern: "liquidity_sweep", direction: "bullish", lookback: 5, timeframe: tf },
        { type: "pattern", pattern: "fvg", direction: "bullish", timeframe: tf },
        { type: "pattern", pattern: "bos", direction: "bullish", lookback: 5, timeframe: tf },
      ],
      // All four must fire — session gates entry, three ICT confirmations
      // align. High-conviction setup, expected low fire rate.
      logic: "all",
    }),
    allowed_timeframes: ["15m"],
  },
  {
    name: "gold_silver_bullet",
    default_side: "long",
    build: (tf) => ({
      entry: [
        // Tighter ICT Silver Bullet 14-16 UTC window.
        { type: "pattern", pattern: "gold_session_window", session: "silver_bullet", timeframe: tf },
        { type: "pattern", pattern: "liquidity_sweep", direction: "bullish", lookback: 5, timeframe: tf },
        { type: "pattern", pattern: "fvg", direction: "bullish", timeframe: tf },
      ],
      logic: "all",
    }),
    allowed_timeframes: ["15m"],
  },
  {
    name: "gold_asian_breakout",
    default_side: "long",
    build: (tf) => ({
      entry: [
        // Bullish break of same-day Asian session high (UTC 00-07).
        { type: "pattern", pattern: "asian_range_break", direction: "bullish", timeframe: tf },
        // Momentum confirmation — break must come with directional impulse.
        { type: "pattern", pattern: "momentum", direction: "bullish", lookback: 3, timeframe: tf },
      ],
      logic: "all",
    }),
    allowed_timeframes: ["15m"],
  },
  {
    name: "gold_h4_trend_pullback",
    default_side: "long",
    build: (tf) => ({
      entry: [
        // D1 bullish bias — gold's most-quantified directional anchor.
        { type: "pattern", pattern: "daily_bias", direction: "bullish", ma_period: 20, timeframe: "1d" },
        // 4h pin bar — bullish rejection candle on the pullback bar.
        { type: "pattern", pattern: "pin_bar", direction: "bullish", timeframe: tf },
        // RSI > 40 — trend-aligned without requiring an oversold dip.
        { type: "technical", indicator: "RSI", operator: "greater_than", value: 40, timeframe: tf },
      ],
      // 2-of-3 — bias + (pin OR RSI). Counter-evidence to the "no long
      // holds" intuition: tests whether 4h trend-pullback survives
      // walk-forward on gold despite the user's preference for 15m.
      logic: { type: "n_of_m", n: 2 },
    }),
    allowed_timeframes: ["4h"],
  },
  {
    name: "gold_d1_sma_trend_filter",
    default_side: "long",
    build: (tf) => ({
      entry: [
        // Long when D1 close crosses above the 200-period SMA. Mirrors
        // the Quantified Strategies edge — 50yr backtest of gold above
        // 200d SMA beat buy-and-hold by avoiding the bearish regimes.
        // value=0 + price-based indicator → backtest engine resolves as
        // "price crosses above SMA200" (lib/market-data/backtest-engine.ts).
        { type: "technical", indicator: "SMA200", operator: "crosses_above", value: 0, timeframe: tf },
      ],
      logic: "all",
    }),
    allowed_timeframes: ["1d"],
  },
  // gold_news_fade DEFERRED until backtest news-replay exists. The
  // template needs `post_news_window` to fire, which requires
  // `WalkForwardOptions.events` populated with historical Finnhub
  // releases. Until that infra lands, including the template here
  // would produce zero candidates in the search (post_news_window
  // returns false on empty events) and waste a slot in the grid.
  // Reintroduce as PR-4 once news-replay is wired — the primitive
  // (post_news_window) is fully built and tested in PR-1; it just
  // needs the backtest data path. Until then, fade strategies remain
  // a live-only consideration (operator can build manually).
  // Bare-indicator templates — last in the grid because they have no
  // multi-TF or pattern context. Useful diversification but rarely
  // beat the pattern templates on the friend's universe.
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
    name: "macd_zero_cross",
    default_side: "auto",
    build: (tf) => ({
      entry: [
        { type: "technical", indicator: "MACD", operator: "crosses_above", value: 0, timeframe: tf },
      ],
      logic: "all",
    }),
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

// Exit variants live in `./exit-variants.ts` so the per-template flip
// rules are isolated from the entry-side template definitions, and so
// this file stays inside the per-function size budget. See
// `EXIT_VARIANTS` import above.

const PARAMETER_GRID: ParameterCombo[] = [
  // 1h timeframe
  { timeframe: "1h", sl_pct: 0.8, tp_pct: 2.4, label: "1h_tight_3R" },
  { timeframe: "1h", sl_pct: 1.2, tp_pct: 3.6, label: "1h_normal_3R" },
  { timeframe: "1h", sl_pct: 1.5, tp_pct: 4.5, label: "1h_loose_3R" },
  // 4h timeframe — for trend-follow templates that benefit from larger bars
  { timeframe: "4h", sl_pct: 1.5, tp_pct: 4.5, label: "4h_normal_3R" },
  // 4h tighter combo — for gold_h4_trend_pullback (counter-evidence to
  // the 15m-only intuition; SL 0.8% targets the typical H4 pullback depth).
  { timeframe: "4h", sl_pct: 0.8, tp_pct: 2.0, label: "4h_tight_2R5" },
  // 15m combos for gold scalp templates. SL bounds match gold's typical
  // 15m ATR (~$5 / 0.2% on $2400) — 0.3% catches small ATR setups,
  // 0.5% gives the trade slightly more room. 3R retained.
  { timeframe: "15m", sl_pct: 0.3, tp_pct: 0.9, label: "15m_tight_3R" },
  { timeframe: "15m", sl_pct: 0.5, tp_pct: 1.5, label: "15m_normal_3R" },
  // 1d combo — the SMA200 trend filter template needs daily bars; SL
  // wide enough to absorb intraday noise inside the trend.
  { timeframe: "1d", sl_pct: 1.5, tp_pct: 4.5, label: "1d_normal_3R" },
];

export interface Candidate {
  /** Stable label for logging and diagnostics. */
  label: string;
  /** Full rule set ready to feed to runWalkForward. */
  rules: AlgorithmRules;
  template_name: string;
}

/**
 * 3D cartesian product of templates × parameter combos × exit variants.
 * Post-filtered by each template's `allowed_timeframes`. With the
 * default templates × params × 3 exit variants, ~150-250 candidates;
 * the search runner caps to its `max_candidates` budget (default 300
 * to fit the full set).
 *
 * The 3rd dimension exists because today's "exit conditions help or
 * hurt is template-specific" empirical finding — bearish-BOS exits
 * doubled ict_bos_orderblock EV (+0.33R → +0.66R) but destroyed
 * momentum_solo (+0.25R → -0.33R). Enumerating exit variants per
 * candidate lets walk-forward pick the empirically best combination.
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
      const isGold = tmpl.name.startsWith("gold_");

      for (const exitVariant of EXIT_VARIANTS) {
        const exit = exitVariant.build(tmpl.name, combo.timeframe, tmpl.default_side);
        if (exit === null) continue;

        const labelSuffix = exitVariant.name === "no_exit" ? "" : `__${exitVariant.name}`;

        out.push({
          label: `${tmpl.name}__${combo.label}${labelSuffix}`,
          template_name: tmpl.name,
          rules: assembleRules(built, combo, tmpl.default_side, input.capital, {
            is_gold: isGold,
            exit_conditions: exit.exit_conditions,
            exit_logic: exit.exit_logic,
          }),
        });
        if (tmpl.include_tf_conviction_variant) {
          // Same conditions/SL/TP/exits, swapped sizing. Walk-forward
          // decides whether the conviction-scaled version edges out
          // flat risk under the same exit shape.
          out.push({
            label: `${tmpl.name}__${combo.label}__conv${labelSuffix}`,
            template_name: tmpl.name,
            rules: assembleRules(built, combo, tmpl.default_side, input.capital, {
              sizing: "conviction_tf_agreement",
              is_gold: isGold,
              exit_conditions: exit.exit_conditions,
              exit_logic: exit.exit_logic,
            }),
          });
        }
      }
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
interface AssembleOptions {
  /** Sizing variant. Default `"risk_per_trade"` (flat). The
   *  `"conviction_tf_agreement"` variant scales risk with cross-TF
   *  agreement count; pairs with `convictionMultiplierByTfAgreement`. */
  sizing?: "risk_per_trade" | "conviction_tf_agreement";
  /** True for gold-specific templates. Sets asset_class to "commodity",
   *  bumps leverage to FTMO's actual 1:50 cap on XAU pairs, and tightens
   *  stagnant_exit on 15m candidates to match gold's faster price action. */
  is_gold?: boolean;
  /** Exit conditions to bake into the rule. Defaults to none ([] +
   *  undefined logic) — preserves the legacy 2D-search behaviour for
   *  any caller that doesn't supply exits. The 3D-enumeration loop
   *  always sets these explicitly. */
  exit_conditions?: EntryCondition[];
  exit_logic?: AlgorithmRules["exit_logic"];
}

function assembleRules(
  built: { entry: EntryCondition[]; logic: EntryLogic },
  combo: ParameterCombo,
  side: "long" | "short" | "auto",
  capital: number,
  options: AssembleOptions = {}
): AlgorithmRules {
  const isGold = options.is_gold ?? false;
  const positionSizing: AlgorithmRules["position_sizing"] =
    options.sizing === "conviction_tf_agreement"
      ? {
          // Base risk = 0.25%. With max_multiplier = 4, peak risk on a
          // full-TF-agreement trade is 1.0% — well inside the FTMO-safe
          // 2% cap, leaving headroom for the calibrator to scale up to
          // the user's monthly target.
          type: "conviction_scaled",
          value: 0.25,
          max_multiplier: 4,
          conviction_metric: "tf_agreement",
        }
      : { type: "risk_per_trade", value: 0.5 };
  // Tighter stagnant_exit on 15m candidates — gold's 15m setups should
  // resolve fast (4h max hold) and we cut deeper into red sooner so spread
  // drag doesn't compound on stalled scalps. Other timeframes use the
  // legacy 48-bar / -0.5R defaults that the active forex algo runs.
  const stagnantExit =
    combo.timeframe === "15m"
      ? {
          enabled: true,
          max_bars: 16,
          min_excursion_r: 0.1,
          min_pnl_r: -0.3,
        }
      : {
          enabled: true,
          max_bars: 48,
          min_excursion_r: 0.1,
          min_pnl_r: -0.5,
        };
  const rules: AlgorithmRules = {
    entry_conditions: built.entry,
    entry_logic: built.logic,
    exit_conditions: options.exit_conditions ?? [],
    ...(options.exit_logic !== undefined ? { exit_logic: options.exit_logic } : {}),
    stop_loss: { type: "percentage", value: combo.sl_pct },
    take_profit: { type: "percentage", value: combo.tp_pct },
    position_sizing: positionSizing,
    max_positions: 5,
    max_per_ticker: 1,
    // FTMO improved gold leverage to 1:50 on 2026-02-01 (XAUUSD/EUR/AUD).
    // Forex stays at the conservative 1:30 — well inside FTMO's actual
    // 1:100 cap but matches the active forex algo's deployed setting.
    leverage: isGold ? 50 : 30,
    timeframe: combo.timeframe,
    asset_class: isGold ? "commodity" : "forex",
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
    stagnant_exit: stagnantExit,
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
