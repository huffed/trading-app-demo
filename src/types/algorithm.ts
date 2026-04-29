export type AlgorithmStatus = "draft" | "active" | "paused" | "archived";
export type RiskLevel = "conservative" | "moderate" | "aggressive";
export type IndicatorOperator = "less_than" | "greater_than" | "crosses_above" | "crosses_below";
export type SentimentOperator = "above" | "below" | "spike_above" | "spike_below";

// --- Discriminated union for conditions ---

export interface TechnicalCondition {
  type: "technical";
  indicator: string;
  operator: IndicatorOperator;
  value: number;
  timeframe: string;
}

export interface SentimentCondition {
  type: "sentiment";
  source: "news" | "social";
  metric: string;
  operator: SentimentOperator;
  threshold: number;
  topics?: string[];
  tickers?: string[];
  timeframe: string;
}

/**
 * ICT/SMC chart-pattern condition. Evaluated by the pattern detector
 * module (`lib/patterns`). Unlike technical conditions which compute on
 * an indicator series, patterns are detected directly from the bar OHLC.
 *
 * Supported patterns (initial set):
 *  - liquidity_sweep: pierce of a recent swing high/low + close back inside
 *  - fvg: 3-bar fair value gap created on the current bar
 *  - ifvg: a previous FVG that has been filled and is now retesting
 *  - daily_bias: higher-timeframe trend filter (D1 close vs N-period MA)
 */
export interface PatternCondition {
  type: "pattern";
  pattern: "liquidity_sweep" | "fvg" | "ifvg" | "daily_bias" | "bos" | "order_block";
  /** Required directional alignment. Omit to match any direction. */
  direction?: "bullish" | "bearish";
  /** Lookback for swing-based patterns. Default 5. */
  lookback?: number;
  /** Period for the daily-bias MA. Default 20. */
  ma_period?: number;
  timeframe: string;
}

export type EntryCondition = TechnicalCondition | SentimentCondition | PatternCondition;
export type ExitCondition = TechnicalCondition | SentimentCondition | PatternCondition;

/**
 * How multiple entry conditions combine.
 *  - "all": every condition must fire on the same bar (default, strictest)
 *  - "any": fires when any one condition is met (loosest)
 *  - { type: "n_of_m", n }: fires when at least n of the conditions are met
 */
export type EntryLogic = "all" | "any" | { type: "n_of_m"; n: number };

export function isTechnicalCondition(c: EntryCondition | ExitCondition): c is TechnicalCondition {
  return c.type === "technical";
}

export function isSentimentCondition(c: EntryCondition | ExitCondition): c is SentimentCondition {
  return c.type === "sentiment";
}

export function isPatternCondition(c: EntryCondition | ExitCondition): c is PatternCondition {
  return c.type === "pattern";
}

// --- Risk management & rules ---

export interface StopLoss {
  type: "percentage" | "fixed" | "pips";
  value: number;
}

export interface TakeProfit {
  type: "percentage" | "fixed" | "pips";
  value: number;
}

export interface PositionSizing {
  type:
    | "percentage_of_capital"
    | "fixed_amount"
    | "fixed_quantity"
    | "lots"
    | "risk_per_trade"
    | "conviction_scaled";
  /**
   * Interpretation depends on type:
   *  - percentage_of_capital: % of equity (e.g. 16 → 16%)
   *  - fixed_amount: USD notional (e.g. 1000 → $1000 per trade)
   *  - fixed_quantity: raw units (shares for stocks)
   *  - lots: lot count (1 = 1 standard lot; 100k forex base or asset-class
   *    contractSize). Notional = lots × contractSize × price.
   *  - risk_per_trade: % of capital that hitting the SL would lose (e.g.
   *    1 → 1% risk). System auto-computes lot size from SL distance + asset
   *    cross-currency rates. Same algo config produces equivalent % returns
   *    on any account size — the strategy scales automatically.
   *  - conviction_scaled: BASE % risk (same shape as risk_per_trade) that
   *    gets multiplied by a conviction factor when more entry conditions
   *    align than the n_of_m threshold requires. Multiplier is linear:
   *    1× at the bare-minimum n hit, scaling up to `max_multiplier` when
   *    every condition fires. Encodes the friend's discretionary 20×
   *    sizing range (0.1 → 2.0 lots) systematically — 70% of his P&L
   *    came from his highest-conviction trades. Falls back to flat
   *    risk_per_trade behaviour for `all` / `any` entry_logic where
   *    "k of M conditions" isn't a meaningful conviction signal.
   */
  value: number;
  /**
   * `conviction_scaled` only. Cap on the conviction multiplier. Default 4
   * — never sizes more than 4× the base risk on a single trade. Friend's
   * actual range was 20× (0.1 → 2.0 lots) but we cap tighter so a
   * mis-tuned algorithm can't accidentally blow up on a strong-confluence
   * but still-losing day.
   */
  max_multiplier?: number;
}

export interface PropFirmRules {
  daily_loss_limit: number; // % of starting balance (e.g., 5)
  max_drawdown: number; // % of starting balance (e.g., 10)
  profit_target: number; // % evaluation target (e.g., 10)
  /**
   * Optional safety kill switch — count of consecutive losses that pulls
   * the bot off the platform. Not a published prop-firm rule; set to 0
   * to disable.
   */
  max_consecutive_losses: number;
  /**
   * Friend's "3 strikes" rule — soft halt that stops NEW entries for the
   * rest of the day after this many consecutive losing trades, but lets
   * existing positions run to their stops/TPs. Resets when the date
   * rolls over so the algo resumes next session. Different from
   * `max_consecutive_losses` which permanently kills the algo (intended
   * as the prop-firm hard safety net, not day-trading discipline).
   * 0 = disabled. Typical value 3.
   */
  consecutive_loss_daily_halt?: number;
  /**
   * Whether `max_consecutive_losses` counts losing trades or losing days.
   * Pyramiding strategies should usually pick "days" so a single bad bar
   * closing 3 stacked positions doesn't blow 75% of the budget at once.
   */
  consecutive_loss_unit?: "trades" | "days";
  /**
   * Defensive halt threshold as a percentage of the daily-loss-limit.
   * The engine force-closes all positions when daily pnl reaches
   * `daily_loss_limit * (daily_loss_halt_pct / 100)`. 100 = halt at exact
   * DLL (no buffer); 80 = halt at 80% of DLL leaving 20% headroom for
   * intra-bar overshoot. Defaults to 100 for backwards compatibility.
   */
  daily_loss_halt_pct?: number;
  consistency_rule: number; // max % of total profit from single day (e.g., 40)
  slippage_bps: number; // basis points per trade (e.g., 10 = 0.1%)
  commission_pct: number; // % per trade (e.g., 0.1)
  /**
   * Broker spread cost per side in basis points. Separate from slippage:
   * spread is the fixed bid/ask gap the broker charges, slippage is the
   * variable cost from execution conditions. Both are deducted from each
   * fill. Defaults to 0 to preserve old backtest results; recommended
   * 3-10 bps for FTMO Demo on majors, higher on JPY crosses.
   */
  spread_bps?: number;
  /**
   * Commission in dollars per lot per round-turn (open + close combined).
   * Mirrors how prop firms / retail brokers actually charge: FTMO forex
   * majors are ~$7/lot, gold typically $7-10/lot. Applied additively to
   * `commission_pct` so an algo can be configured for either or both.
   * Defaults to 0 (no per-lot commission deducted from backtest pnl).
   * The backtest engine derives lot count from notional / contractSize,
   * so symbols without a contractSize entry skip the per-lot fee.
   */
  commission_per_lot?: number;
}

/**
 * News-window veto: blocks new entries inside [-before, +after] minutes
 * around economic events that affect the symbol's currencies. Highest-EV
 * use of news data per public-strategy research — strips out the
 * slippage/fake-fill losses common around CPI/NFP/FOMC.
 */
export interface NewsVetoRules {
  enabled: boolean;
  /** Block window minutes BEFORE the release. */
  block_minutes_before: number;
  /** Block window minutes AFTER the release. */
  block_minutes_after: number;
  /** Only events at or above this impact level fire the veto. */
  min_impact: "low" | "medium" | "high";
}

export interface AlgorithmRules {
  entry_conditions: EntryCondition[];
  /** Logic combining entry conditions. Defaults to "all" for backwards compat. */
  entry_logic?: EntryLogic;
  exit_conditions: ExitCondition[];
  /**
   * Logic combining exit conditions. Falls back to entry_logic when
   * undefined so legacy algos preserve their behaviour. New algos default
   * to "any" via clampRules — typical exit semantics fire on the first
   * confirming signal rather than waiting for all to align.
   */
  exit_logic?: EntryLogic;
  stop_loss: StopLoss;
  take_profit: TakeProfit;
  position_sizing: PositionSizing;
  max_positions: number;
  /** Pyramiding cap per symbol. Defaults to 1 (no stacking). */
  max_per_ticker?: number;
  /**
   * Account leverage ratio for margin calculations. Only matters when
   * position_sizing.type === "lots". 30 = 30:1 (default), 100 = 100:1
   * (typical FTMO forex). Backwards compatible: omitted = unlimited
   * margin (legacy non-leveraged behaviour).
   */
  leverage?: number;
  timeframe: string;
  asset_class: string;
  /**
   * Trade direction the algorithm commits to:
   *  - "long" / "short": fixed bias, default "long".
   *  - "auto": regime-adaptive — at each entry the engine reads the
   *    higher-timeframe bias on the ticker and trades that direction.
   *    Pattern conditions' configured `direction` filter is overridden
   *    to match the active bias for that bar, so a single algo trades
   *    longs in bullish regimes and shorts in bearish regimes on the
   *    same pair without reconfiguration. Skips entry when D1 is neutral.
   */
  side?: "long" | "short" | "auto";
  prop_firm?: PropFirmRules;
  news_veto?: NewsVetoRules;
  /**
   * Cumulative paper-vs-broker divergence kill switch. Computes the rolling
   * mean of |broker_fill_price - entry_price| in basis points (bp = 0.01%
   * of price) across the last N entries with a recorded broker fill. When
   * the mean exceeds the limit AND we have at least N samples, live trading
   * is disabled on the algorithm. Backtests assume 10 bp slippage; defaults
   * are tuned to flag "real fills are materially worse than the model".
   */
  divergence_kill?: {
    /** Average absolute divergence threshold in bps (e.g., 20 = 0.20%). */
    max_avg_bps: number;
    /** Window size in trades. Lower = faster reaction, more variance. */
    window_trades: number;
  };
  /**
   * Volatility-regime gate: skip entries when 20-period ATR drops below
   * a percentile floor of its recent distribution. Choppy / compressed
   * tape historically whipsaws our pattern strategies before TPs can
   * develop — testing 3's Sep/Mar/Feb 0% WR months were all in the
   * bottom-30th-percentile ATR regime.
   */
  regime_filter?: {
    enabled: boolean;
    /** Periods for the ATR average. Default 20. */
    atr_period?: number;
    /** Lookback bars used to build the percentile distribution. Default 90. */
    lookback_days?: number;
    /** Skip when current ATR is below this percentile (0..1). Default 0.30. */
    percentile_floor?: number;
  };
  /**
   * Trend-strength gate using ADX. Skips entries when ADX is below the
   * minimum threshold — i.e. there's no clear directional trend. ATR-
   * percentile didn't work because low ATR ≠ ranging; ADX directly
   * measures whether bulls or bears are in control.
   */
  adx_filter?: {
    enabled: boolean;
    /** ADX lookback period. Default 14. */
    adx_period?: number;
    /** Minimum ADX to allow entries. Default 20 (below = ranging). */
    min_adx?: number;
  };
  /**
   * Stagnant-loser early exit. Closes a position open ≥ N bars that
   * never reached `min_excursion_r` favourable excursion AND is still
   * sitting at or below `min_pnl_r`. Encodes the friend's "cut what
   * isn't working" discipline. `max_bars` is auto-derived from local
   * ATR when undefined: `clamp(round(SL_distance / ATR(14) * 0.5), 2, 12)`.
   * The auto formula adapts per timeframe / symbol / volatility regime;
   * pin a number explicitly only when an algo wants override.
   */
  stagnant_exit?: {
    enabled: boolean;
    max_bars?: number;
    /** R-units. Default 0.5. */
    min_excursion_r?: number;
    /** R-units. Default 0. */
    min_pnl_r?: number;
  };
}

// --- Backtest results ---

export interface BacktestResults {
  total_return: number;
  max_drawdown: number;
  sharpe_ratio: number;
  total_trades: number;
  win_rate: number;
  equity_curve: { date: string; value: number }[];
}

// --- Algorithm entity ---

export interface Algorithm {
  id: string;
  user_id: string;
  name: string;
  description: string;
  asset_class: string;
  risk_level: RiskLevel;
  time_horizon: string;
  capital: number;
  user_hints: string | null;
  rules: AlgorithmRules;
  ai_analysis: string | null;
  backtest_results: BacktestResults | null;
  status: AlgorithmStatus;
  last_scanned_at: string | null;
  // Live trading wiring (Phase B)
  live_trading_enabled?: boolean;
  broker_connection_id?: string | null;
  /** Optional portfolio grouping — when set, the portfolio's halt rules
   *  apply to this algo. ON DELETE SET NULL on the portfolio. */
  portfolio_id?: string | null;
  /** Account leverage ratio used for margin calculations on lots-sized algos.
   *  Mirrors AlgorithmRules.leverage so backtest + live agree. */
  leverage?: number;
  /** Cutoff timestamp for drift / pair-quality calculations. Trades closed
   *  before this point are excluded so a fix-driven baseline reset doesn't
   *  poison the rolling metrics. */
  metrics_reset_at?: string | null;
  created_at: string;
  updated_at: string;
}

export type AlgorithmInsert = Omit<
  Algorithm,
  "id" | "user_id" | "ai_analysis" | "backtest_results" | "created_at" | "updated_at"
>;

export type AlgorithmUpdate = Partial<AlgorithmInsert>;
