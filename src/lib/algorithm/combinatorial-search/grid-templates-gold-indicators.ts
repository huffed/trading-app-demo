/**
 * Gold-specific + bare-indicator template definitions for the
 * combinatorial search. Extracted from `grid-templates.ts` on
 * 2026-06-22 (CB.H1 pass 19) so the main template file stays
 * focused on the high-priority pattern/multi-TF templates and the
 * cardinality of templates per file stays manageable.
 *
 * Two groups:
 *  - GOLD_TEMPLATES — gold-scoped primitives (gold_session_window,
 *    asian_range_break) + gold-tuned indicator combos (SMA200 trend).
 *  - INDICATOR_TEMPLATES — bare-indicator templates (RSI extremes,
 *    SMA/EMA crossovers, BollingerBands bounce, MACD zero-cross).
 *
 * The orchestrator at `grid-templates.ts` concatenates these into the
 * full TEMPLATES catalog in the documented priority order: pattern/
 * multi-TF first, then gold, then bare-indicator.
 */
import type { Template } from "./grid-templates";

export const GOLD_TEMPLATES: Template[] = [
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
];

export const INDICATOR_TEMPLATES: Template[] = [
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
    param_variants: [
      {
        name: "rsi25",
        build: (tf) => ({
          entry: [
            { type: "technical", indicator: "RSI", operator: "less_than", value: 25, timeframe: tf },
          ],
          logic: "all",
        }),
      },
      {
        name: "rsi35",
        build: (tf) => ({
          entry: [
            { type: "technical", indicator: "RSI", operator: "less_than", value: 35, timeframe: tf },
          ],
          logic: "all",
        }),
      },
    ],
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
    param_variants: [
      {
        name: "rsi65",
        build: (tf) => ({
          entry: [
            { type: "technical", indicator: "RSI", operator: "greater_than", value: 65, timeframe: tf },
          ],
          logic: "all",
        }),
      },
      {
        name: "rsi75",
        build: (tf) => ({
          entry: [
            { type: "technical", indicator: "RSI", operator: "greater_than", value: 75, timeframe: tf },
          ],
          logic: "all",
        }),
      },
      {
        name: "rsi80",
        build: (tf) => ({
          entry: [
            { type: "technical", indicator: "RSI", operator: "greater_than", value: 80, timeframe: tf },
          ],
          logic: "all",
        }),
      },
    ],
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
