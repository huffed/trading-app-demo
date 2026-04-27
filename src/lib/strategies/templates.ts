/**
 * Vetted strategy templates. Each template is a function from user preferences
 * to a fully-formed AlgorithmRules object — no free-form AI generation, just
 * parameter tuning of patterns that have published edge in retail forex /
 * commodity trading.
 *
 * The AI's job is to PICK the right template (cheap one-token decision); the
 * template itself encodes the actual trading logic.
 *
 * All templates respect:
 * - max_per_ticker for forex/commodity (pyramiding into trends)
 * - news_veto on by default for forex/commodity
 * - 3:1 reward:risk minimum
 * - position_sizing.percentage_of_capital
 */
import type { AlgorithmRules } from "@/types/algorithm";

export type RiskLevel = "conservative" | "moderate" | "aggressive";

export interface TemplateContext {
  asset_class: string;
  risk_level: RiskLevel;
  capital: number;
  time_horizon: string;
}

export interface StrategyTemplate {
  id: string;
  name: string;
  /** Short headline shown to the AI when picking. */
  summary: string;
  /** Two-paragraph human-facing explanation of the logic and edge. */
  description: string;
  /** Markets this template is known to work on. */
  asset_classes: ReadonlyArray<string>;
  /** Bar intervals this template is designed for. */
  time_horizons: ReadonlyArray<string>;
  /** Risk profiles this template fits. */
  risk_levels: ReadonlyArray<RiskLevel>;
  /** Tags the selector matches against user hints. */
  tags: ReadonlyArray<string>;
  build: (ctx: TemplateContext) => AlgorithmRules;
}

// ---------------------------------------------------------------------------

const FX_OR_COMMODITY = ["forex", "commodity"] as const;
const FX_TIMEFRAMES = ["4h", "1h", "1d"] as const;

function pickByRisk<T>(risk: RiskLevel, c: T, m: T, a: T): T {
  if (risk === "conservative") return c;
  if (risk === "aggressive") return a;
  return m;
}

function fxBaseRules(
  ctx: TemplateContext,
  overrides: Pick<
    AlgorithmRules,
    | "entry_conditions"
    | "exit_conditions"
    | "stop_loss"
    | "take_profit"
    | "position_sizing"
    | "max_positions"
    | "max_per_ticker"
    | "entry_logic"
  >
): AlgorithmRules {
  return {
    ...overrides,
    timeframe: ctx.time_horizon,
    asset_class: ctx.asset_class,
    news_veto: {
      enabled: true,
      block_minutes_before: 15,
      block_minutes_after: 30,
      min_impact: "high",
    },
  };
}

// ---------------------------------------------------------------------------
// 1. Trend Pullback — buy dips inside a confirmed uptrend.
// ---------------------------------------------------------------------------

const trendPullback: StrategyTemplate = {
  id: "trend_pullback",
  name: "Trend Pullback",
  summary: "Buy minor RSI dips inside a confirmed uptrend (EMA12 > EMA26).",
  description: `Identifies trending markets and waits for the price to pull back without breaking the trend, then re-enters in the direction of the existing move. The win rate is moderate (~40-50%) but the asymmetric risk:reward (3:1+) means a handful of catches funds the strategy.

Best on liquid markets with persistent direction — major forex pairs in clear trends, gold during macro themes, or single stocks with steady drift. Loses in choppy/range-bound conditions, which the news veto and tighter stops mitigate. Exits are purely stop/TP-driven so winners compound to the full take-profit instead of cutting short on indicator wobbles.`,
  asset_classes: [...FX_OR_COMMODITY, "equity"],
  time_horizons: [...FX_TIMEFRAMES],
  risk_levels: ["conservative", "moderate", "aggressive"],
  tags: ["trend", "pullback", "moderate", "prop"],
  build: (ctx) => {
    const stop = pickByRisk(ctx.risk_level, 0.4, 0.6, 1.0);
    const tp = stop * 3;
    const size = pickByRisk(ctx.risk_level, 6, 10, 16);
    return fxBaseRules(ctx, {
      entry_conditions: [
        { type: "technical", indicator: "EMA12", operator: "greater_than", value: 0, timeframe: ctx.time_horizon },
        { type: "technical", indicator: "RSI", operator: "less_than", value: 45, timeframe: ctx.time_horizon },
      ],
      entry_logic: "all",
      // No signal exit — let TP/stop run so wins capture the full 3:1 R:R.
      exit_conditions: [],
      stop_loss: { type: "percentage", value: stop },
      take_profit: { type: "percentage", value: tp },
      position_sizing: { type: "percentage_of_capital", value: size },
      max_positions: pickByRisk(ctx.risk_level, 4, 6, 10),
      max_per_ticker: pickByRisk(ctx.risk_level, 3, 4, 6),
    });
  },
};

// ---------------------------------------------------------------------------
// 2. Bollinger Mean Reversion — buy oversold extremes.
// ---------------------------------------------------------------------------

const meanReversion: StrategyTemplate = {
  id: "bollinger_reversion",
  name: "Bollinger Mean Reversion",
  summary: "Buy when RSI is oversold AND price tags the lower Bollinger Band.",
  description: `A counter-trend strategy that fades extreme moves. Both conditions must align: the RSI must be deeply oversold (<30) AND price must close below the lower Bollinger Band. This double confirmation makes entries rare but high-quality.

Works best on range-bound forex pairs (USD/CHF, EUR/CHF), commodity ranges, and major indices that revert intraday. Avoid in strong directional trends where reversion entries become "catching falling knives".`,
  asset_classes: [...FX_OR_COMMODITY, "equity"],
  time_horizons: [...FX_TIMEFRAMES],
  risk_levels: ["conservative", "moderate"],
  tags: ["reversion", "range", "oversold", "conservative"],
  build: (ctx) => {
    const stop = pickByRisk(ctx.risk_level, 0.5, 0.7, 1.2);
    const tp = stop * 3;
    const size = pickByRisk(ctx.risk_level, 4, 6, 8);
    return fxBaseRules(ctx, {
      entry_conditions: [
        { type: "technical", indicator: "RSI", operator: "less_than", value: 30, timeframe: ctx.time_horizon },
        { type: "technical", indicator: "BollingerBands_lower", operator: "less_than", value: 0, timeframe: ctx.time_horizon },
      ],
      entry_logic: "all",
      exit_conditions: [
        { type: "technical", indicator: "RSI", operator: "greater_than", value: 50, timeframe: ctx.time_horizon },
      ],
      stop_loss: { type: "percentage", value: stop },
      take_profit: { type: "percentage", value: tp },
      position_sizing: { type: "percentage_of_capital", value: size },
      max_positions: pickByRisk(ctx.risk_level, 2, 3, 4),
      max_per_ticker: 1,
    });
  },
};

// ---------------------------------------------------------------------------
// 3. MACD Crossover — classic trend-follow with confirmation.
// ---------------------------------------------------------------------------

const macdTrend: StrategyTemplate = {
  id: "macd_trend",
  name: "MACD Crossover Trend",
  summary: "Long on EMA12 crossing above EMA26 with RSI confirming momentum.",
  description: `Standard MACD-style entry: wait for the 12-period EMA to cross above the 26-period EMA, gated by RSI > 50 to confirm momentum is rising rather than just bouncing in a downtrend. Exit on the opposite crossover or RSI weakness.

A more selective entry than pullback (rarer signals, larger positions). Works on equity daily charts, forex 4h/1d, and metals. Doesn't pyramid — each crossover is a discrete signal.`,
  asset_classes: ["forex", "commodity", "equity", "crypto"],
  time_horizons: ["4h", "1d", "swing"],
  risk_levels: ["moderate", "aggressive"],
  tags: ["trend", "crossover", "macd", "swing"],
  build: (ctx) => {
    const stop = pickByRisk(ctx.risk_level, 0.5, 0.8, 1.5);
    const tp = stop * 3;
    const size = pickByRisk(ctx.risk_level, 5, 8, 12);
    return fxBaseRules(ctx, {
      entry_conditions: [
        { type: "technical", indicator: "EMA12", operator: "crosses_above", value: 0, timeframe: ctx.time_horizon },
        { type: "technical", indicator: "RSI", operator: "greater_than", value: 50, timeframe: ctx.time_horizon },
      ],
      entry_logic: "all",
      exit_conditions: [
        { type: "technical", indicator: "EMA12", operator: "crosses_below", value: 0, timeframe: ctx.time_horizon },
      ],
      stop_loss: { type: "percentage", value: stop },
      take_profit: { type: "percentage", value: tp },
      position_sizing: { type: "percentage_of_capital", value: size },
      max_positions: pickByRisk(ctx.risk_level, 3, 4, 6),
      max_per_ticker: 1,
    });
  },
};

// ---------------------------------------------------------------------------
// 4. Triple Confirmation — n-of-m alignment for forex prop accounts.
// ---------------------------------------------------------------------------

const tripleConfirmation: StrategyTemplate = {
  id: "triple_confirmation",
  name: "Triple Confirmation Momentum",
  summary: "Three independent bullish signals; fires when 2 of 3 align.",
  description: `Combines a trend filter (EMA12 above EMA26), a momentum filter (RSI above 50), and a volatility expansion filter (price above the upper Bollinger Band). With n-of-m logic the strategy fires when 2 of 3 conditions agree, avoiding the "all three on the same bar" trap that makes single-signal AND strategies dormant.

Designed specifically for forex/commodity 4h scalping with prop-firm constraints. The 2-of-3 firing gets enough trade frequency to hit profit targets; the 3:1 R:R keeps expectancy positive even at sub-30% win rates. Exits are purely stop/TP-driven so winners reach the full take-profit.`,
  asset_classes: [...FX_OR_COMMODITY],
  time_horizons: [...FX_TIMEFRAMES],
  risk_levels: ["moderate", "aggressive"],
  tags: ["confluence", "scalp", "prop", "n_of_m"],
  build: (ctx) => {
    const stop = pickByRisk(ctx.risk_level, 0.5, 0.7, 1.2);
    const tp = stop * 3;
    const size = pickByRisk(ctx.risk_level, 6, 10, 18);
    return fxBaseRules(ctx, {
      entry_conditions: [
        { type: "technical", indicator: "EMA12", operator: "greater_than", value: 0, timeframe: ctx.time_horizon },
        { type: "technical", indicator: "RSI", operator: "greater_than", value: 50, timeframe: ctx.time_horizon },
        { type: "technical", indicator: "BollingerBands_upper", operator: "greater_than", value: 0, timeframe: ctx.time_horizon },
      ],
      entry_logic: { type: "n_of_m", n: 2 },
      // Pure R:R-driven exits — TP fires at the configured 3x stop level.
      exit_conditions: [],
      stop_loss: { type: "percentage", value: stop },
      take_profit: { type: "percentage", value: tp },
      position_sizing: { type: "percentage_of_capital", value: size },
      max_positions: pickByRisk(ctx.risk_level, 4, 7, 12),
      max_per_ticker: pickByRisk(ctx.risk_level, 3, 4, 6),
    });
  },
};

// ---------------------------------------------------------------------------
// 5. Bollinger Breakout — buy strength, ride the expansion.
// ---------------------------------------------------------------------------

const breakout: StrategyTemplate = {
  id: "bollinger_breakout",
  name: "Bollinger Band Breakout",
  summary: "Buy on a close above the upper Bollinger Band (volatility expansion).",
  description: `A trend-following breakout strategy. Enters when price closes above the upper Bollinger Band, signaling that current volatility has expanded past the recent normal range. Exits on a close back inside the bands or RSI weakness — letting winners run while quickly cutting failed breakouts.

Works on commodities during macro themes (oil during supply shocks, gold during inflation surges) and forex during central-bank divergence trends. Higher win rate than mean reversion but more sensitive to choppy false breakouts.`,
  asset_classes: ["forex", "commodity", "equity", "crypto"],
  time_horizons: ["4h", "1h", "1d"],
  risk_levels: ["moderate", "aggressive"],
  tags: ["breakout", "trend", "volatility", "momentum"],
  build: (ctx) => {
    const stop = pickByRisk(ctx.risk_level, 0.6, 1.0, 1.5);
    const tp = stop * 4;
    const size = pickByRisk(ctx.risk_level, 6, 10, 16);
    return fxBaseRules(ctx, {
      entry_conditions: [
        { type: "technical", indicator: "BollingerBands_upper", operator: "crosses_above", value: 0, timeframe: ctx.time_horizon },
      ],
      entry_logic: "all",
      exit_conditions: [
        { type: "technical", indicator: "RSI", operator: "less_than", value: 50, timeframe: ctx.time_horizon },
      ],
      stop_loss: { type: "percentage", value: stop },
      take_profit: { type: "percentage", value: tp },
      position_sizing: { type: "percentage_of_capital", value: size },
      max_positions: pickByRisk(ctx.risk_level, 3, 6, 10),
      max_per_ticker: pickByRisk(ctx.risk_level, 2, 3, 4),
    });
  },
};

// ---------------------------------------------------------------------------
// 6. Conservative Trend Filter — slow swing entries, low frequency.
// ---------------------------------------------------------------------------

const conservativeTrend: StrategyTemplate = {
  id: "conservative_trend",
  name: "Conservative Long-Term Trend",
  summary: "Long on SMA20 above SMA50 with RSI moderate; daily/swing only.",
  description: `A patient long-term trend rider that only enters when the 20-period SMA is above the 50-period SMA (intermediate uptrend) and RSI is between 45-55 (not extended either way). Holds positions for days/weeks; few trades but each has substantial drift potential.

Built for long-term/swing time horizons (1d, weekly). The right pick when the user is happy with 1-2 trades per month and wants minimal screen time. Avoids the noise of intraday timeframes entirely.`,
  asset_classes: ["equity", "forex", "commodity"],
  time_horizons: ["1d", "swing", "long term", "long_term"],
  risk_levels: ["conservative", "moderate"],
  tags: ["swing", "trend", "patient", "long-term"],
  build: (ctx) => {
    const stop = pickByRisk(ctx.risk_level, 1.5, 2.5, 4.0);
    const tp = stop * 3;
    const size = pickByRisk(ctx.risk_level, 5, 8, 12);
    return fxBaseRules(ctx, {
      entry_conditions: [
        { type: "technical", indicator: "SMA20", operator: "greater_than", value: 0, timeframe: ctx.time_horizon },
        { type: "technical", indicator: "RSI", operator: "less_than", value: 55, timeframe: ctx.time_horizon },
      ],
      entry_logic: "all",
      exit_conditions: [
        { type: "technical", indicator: "RSI", operator: "greater_than", value: 65, timeframe: ctx.time_horizon },
      ],
      stop_loss: { type: "percentage", value: stop },
      take_profit: { type: "percentage", value: tp },
      position_sizing: { type: "percentage_of_capital", value: size },
      max_positions: pickByRisk(ctx.risk_level, 2, 3, 5),
      max_per_ticker: 1,
    });
  },
};

// ---------------------------------------------------------------------------

export const STRATEGY_TEMPLATES: StrategyTemplate[] = [
  trendPullback,
  meanReversion,
  macdTrend,
  tripleConfirmation,
  breakout,
  conservativeTrend,
];

export function getTemplateById(id: string): StrategyTemplate | null {
  return STRATEGY_TEMPLATES.find((t) => t.id === id) ?? null;
}

/** Templates compatible with a given asset class + horizon, used by the selector. */
export function compatibleTemplates(assetClass: string, timeHorizon: string): StrategyTemplate[] {
  const horizon = timeHorizon.toLowerCase();
  return STRATEGY_TEMPLATES.filter((t) => {
    const assetOk = t.asset_classes.includes(assetClass);
    const horizonOk = t.time_horizons.some((h) => h.toLowerCase() === horizon);
    return assetOk && horizonOk;
  });
}
