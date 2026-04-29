export const TECHNICAL_OP_LABELS: Record<string, string> = {
  less_than: "<",
  greater_than: ">",
  crosses_above: "crosses above",
  crosses_below: "crosses below",
};

export const PATTERN_LABELS: Record<string, string> = {
  liquidity_sweep: "Liquidity sweep",
  fvg: "Fair Value Gap (FVG)",
  ifvg: "Inverse FVG",
  daily_bias: "Daily bias",
  bos: "Break of Structure (BOS)",
  order_block: "Order block",
  engulfing: "Engulfing candle",
  pin_bar: "Pin bar (rejection)",
  momentum: "Momentum continuation",
};

export const PATTERN_DIRECTION_LABELS: Record<string, string> = {
  any: "Either direction",
  bullish: "Bullish only",
  bearish: "Bearish only",
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

export const WATCHLIST_ADDED_BY_LABELS: Record<string, string> = {
  user: "Manual",
  ai: "AI",
  csv: "CSV",
};

export const AUTONOMY_LEVEL_LABELS: Record<string, string> = {
  paper_only: "Paper only",
  suggest: "Signals only (no auto-execution)",
  semi_auto: "Semi-auto (per-trade approval)",
  full_auto: "Full auto",
};

export const AUTONOMY_LEVEL_DESCRIPTIONS: Record<string, string> = {
  paper_only: "Algorithms scan and record paper positions. No real broker orders.",
  suggest: "Algorithms surface signals; you place every trade by hand.",
  semi_auto: "Algorithms execute live trades, but with stricter halts and per-trade alerts.",
  full_auto: "Algorithms execute live trades autonomously, gated only by configured halts.",
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
  manage_tick: "Manage Tick",
};
