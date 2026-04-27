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

export type EntryCondition = TechnicalCondition | SentimentCondition;
export type ExitCondition = TechnicalCondition | SentimentCondition;

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

// --- Risk management & rules ---

export interface StopLoss {
  type: "percentage" | "fixed";
  value: number;
}

export interface TakeProfit {
  type: "percentage" | "fixed";
  value: number;
}

export interface PositionSizing {
  type: "percentage_of_capital" | "fixed_amount" | "fixed_quantity";
  value: number;
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
  stop_loss: StopLoss;
  take_profit: TakeProfit;
  position_sizing: PositionSizing;
  max_positions: number;
  /** Pyramiding cap per symbol. Defaults to 1 (no stacking). */
  max_per_ticker?: number;
  timeframe: string;
  asset_class: string;
  prop_firm?: PropFirmRules;
  news_veto?: NewsVetoRules;
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
  created_at: string;
  updated_at: string;
}

export type AlgorithmInsert = Omit<
  Algorithm,
  "id" | "user_id" | "ai_analysis" | "backtest_results" | "created_at" | "updated_at"
>;

export type AlgorithmUpdate = Partial<AlgorithmInsert>;
