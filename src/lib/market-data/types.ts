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

export interface BacktestMetrics {
  total_return: number;
  max_drawdown: number;
  sharpe_ratio: number;
  total_trades: number;
  win_rate: number;
  equity_curve: { date: string; value: number }[];
  open_position: OpenPosition | null;
  sentiment_conditions_excluded: number;
  backtest_mode: "full" | "technical_only";
}
