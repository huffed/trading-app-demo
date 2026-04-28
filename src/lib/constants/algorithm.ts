export const TECHNICAL_OP_LABELS: Record<string, string> = {
  less_than: "<",
  greater_than: ">",
  crosses_above: "crosses above",
  crosses_below: "crosses below",
};

export const SENTIMENT_OP_LABELS: Record<string, string> = {
  above: ">",
  below: "<",
  spike_above: "spikes above",
  spike_below: "spikes below",
};

export const STATUS_COLORS: Record<string, "default" | "secondary" | "outline"> = {
  draft: "secondary",
  active: "default",
  paused: "outline",
  archived: "secondary",
};

export const ASSET_CLASS_LABELS: Record<string, string> = {
  equity: "Stocks",
  option: "Options",
  future: "Futures",
  forex: "Forex",
  crypto: "Crypto",
  commodity: "Commodities",
};

export const RISK_LEVEL_LABELS: Record<string, string> = {
  conservative: "Conservative",
  moderate: "Moderate",
  aggressive: "Aggressive",
};

export const RISK_LEVEL_COLORS: Record<string, string> = {
  conservative: "text-[var(--profit)]",
  moderate: "text-primary",
  aggressive: "text-[var(--loss)]",
};

export const STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  active: "Active",
  paused: "Paused",
  archived: "Archived",
};

export const EXIT_REASON_LABELS: Record<string, string> = {
  stop_loss: "Stop Loss",
  take_profit: "Take Profit",
  exit_signal: "Exit Signal",
  manual: "Manual Close",
};

export const ACTIVITY_TYPE_LABELS: Record<string, string> = {
  scan_started: "Scan Started",
  scan_completed: "Scan Completed",
  signal_detected: "Signal Detected",
  signal_no_action: "No Action",
  position_opened: "Position Opened",
  position_closed: "Position Closed",
  stop_loss_hit: "Stop Loss Hit",
  take_profit_hit: "Take Profit Hit",
  error: "Error",
  pair_auto_paused: "Pair Auto-Paused",
  daily_loss_halt: "Daily Loss Halt",
  portfolio_halt: "Portfolio Halt",
  drift_halt: "Drift Halt",
  divergence_halt: "Divergence Halt",
  live_order_placed: "Live Order Placed",
  live_order_failed: "Live Order Failed",
  live_order_closed: "Live Order Closed",
  live_close_failed: "Live Close Failed",
  scan_overdue: "Scan Overdue",
  broker_reconciliation_drift: "Broker Drift",
};
