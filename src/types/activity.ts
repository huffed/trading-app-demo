export type ActivityEventType =
  | "scan_started"
  | "scan_completed"
  | "signal_detected"
  | "signal_no_action"
  | "position_opened"
  | "position_closed"
  | "stop_loss_hit"
  | "take_profit_hit"
  | "error"
  | "pair_auto_paused"
  | "daily_loss_halt"
  | "portfolio_halt"
  | "drift_halt"
  | "divergence_halt"
  | "live_order_placed"
  | "live_order_failed"
  | "live_order_closed"
  | "live_close_failed"
  | "scan_overdue"
  | "broker_reconciliation_drift";

export interface ActivityLogEntry {
  id: string;
  user_id: string;
  algorithm_id: string | null;
  position_id: string | null;
  event_type: ActivityEventType;
  ticker: string | null;
  details: Record<string, unknown>;
  created_at: string;
}

export interface ActivityFilters {
  algorithm_id?: string;
  ticker?: string;
  event_type?: ActivityEventType;
  date_from?: string;
  date_to?: string;
}
