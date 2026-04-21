export type AlgorithmStatus = "draft" | "active" | "paused" | "archived";
export type RiskLevel = "conservative" | "moderate" | "aggressive";
export type IndicatorOperator = "less_than" | "greater_than" | "crosses_above" | "crosses_below";

export interface EntryCondition {
  indicator: string;
  operator: IndicatorOperator;
  value: number;
  timeframe: string;
}

export interface ExitCondition {
  indicator: string;
  operator: IndicatorOperator;
  value: number;
  timeframe: string;
}

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

export interface AlgorithmRules {
  entry_conditions: EntryCondition[];
  exit_conditions: ExitCondition[];
  stop_loss: StopLoss;
  take_profit: TakeProfit;
  position_sizing: PositionSizing;
  max_positions: number;
  timeframe: string;
  asset_class: string;
}

export interface BacktestResults {
  total_return: number;
  max_drawdown: number;
  sharpe_ratio: number;
  total_trades: number;
  win_rate: number;
  equity_curve: { date: string; value: number }[];
}

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
  created_at: string;
  updated_at: string;
}

export type AlgorithmInsert = Omit<
  Algorithm,
  "id" | "user_id" | "ai_analysis" | "backtest_results" | "created_at" | "updated_at"
>;

export type AlgorithmUpdate = Partial<AlgorithmInsert>;
