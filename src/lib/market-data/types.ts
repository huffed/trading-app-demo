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

/** Exit reason taxonomy — mirrors paper_positions.exit_reason from the
 *  live engine. `stop_loss_hit` / `take_profit_hit` set when the bar's
 *  high/low touches the SL/TP price respectively (trailing-adjusted SL
 *  counted as stop_loss_hit). `signal_exit` set when the algo's
 *  exit_conditions or a drawdown-breach trigger force-close. `stagnant_exit`
 *  set when the stagnant gate forced close. `force_close` covers daily-
 *  loss-limit halts and end-of-corpus / end-of-chunk position drains. */
export type BacktestExitReason =
  | "stop_loss_hit"
  | "take_profit_hit"
  | "signal_exit"
  | "stagnant_exit"
  | "force_close";

export interface BacktestTrade {
  entry_date: string;
  exit_date: string;
  entry_price: number;
  exit_price: number;
  side: "long" | "short";
  pnl: number;
  /** Set on portfolio backtests so the trade list can show which pair fired. */
  ticker?: string;
  /** Optional for backwards-compatibility with pre-2026-06-16 callers.
   *  Populated by the prop-firm + portfolio backtest engines. Unlocks
   *  per-outcome MFE/MAE slicing (PR #233 follow-on to #226 MFE/MAE). */
  exit_reason?: BacktestExitReason;
  /** E2.24.d.i — gross max-adverse-excursion in dollars (notional ×
   *  worst adverse %), the position's deepest floating loss while open.
   *  Populated by the portfolio engine; lets `stressTest` reconstruct a
   *  floating-inclusive equity trough. Absent on legacy/simple callers. */
  mae?: number;
  /** E2.24.d.ii — portfolio equity at the instant this position opened.
   *  Lets `stressTest` de-compound pnl to a fixed window-start capital
   *  (exact under risk_per_trade sizing). Absent on legacy callers. */
  equity_at_entry?: number;
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

export interface PerTickerSummary {
  ticker: string;
  trades: number;
  return_pct: number;
  win_rate: number;
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
  /** Set on portfolio backtests; absent on single-ticker. */
  per_ticker?: PerTickerSummary[];
}
