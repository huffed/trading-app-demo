export interface RealTimeQuote {
  symbol: string;
  price: number;
  previousClose: number | null;
  change: number | null;
  changePercent: number | null;
  timestamp: number;
}

export interface PriceBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface BacktestTrade {
  entry_date: string;
  exit_date: string;
  entry_price: number;
  exit_price: number;
  side: "long" | "short";
  pnl: number;
}

export interface OpenPosition {
  entry_date: string;
  entry_price: number;
  current_price: number;
  side: "long" | "short";
  unrealized_pnl: number;
  unrealized_pnl_pct: number;
}

export interface PropFirmReport {
  daily_loss_breaches: number;
  max_daily_loss: number;
  peak_drawdown: number;
  drawdown_breached: boolean;
  max_consecutive_losses: number;
  kill_switch_triggered: boolean;
  consistency_pass: boolean;
  worst_day_pct_of_profit: number;
  total_slippage: number;
  total_commission: number;
  profit_target_met: boolean;
  evaluation_result: "pass" | "fail";
  fail_reasons: string[];
}

export interface BacktestMetrics {
  total_return: number;
  max_drawdown: number;
  sharpe_ratio: number;
  total_trades: number;
  win_rate: number;
  equity_curve: { date: string; value: number }[];
  trades: BacktestTrade[];
  prices: PriceBar[];
  open_position: OpenPosition | null;
  sentiment_conditions_excluded: number;
  backtest_mode: "full" | "technical_only";
  prop_firm_report?: PropFirmReport;
}
