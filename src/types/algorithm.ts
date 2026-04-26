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
  max_consecutive_losses: number; // kill switch threshold (e.g., 5)
  consistency_rule: number; // max % of total profit from single day (e.g., 40)
  slippage_bps: number; // basis points per trade (e.g., 10 = 0.1%)
  commission_pct: number; // % per trade (e.g., 0.1)
}

export interface AlgorithmRules {
  entry_conditions: EntryCondition[];
  exit_conditions: ExitCondition[];
  stop_loss: StopLoss;
  take_profit: TakeProfit;
  position_sizing: PositionSizing;
  max_positions: number;
  timeframe: string;
  asset_class: string;
  prop_firm?: PropFirmRules;
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
