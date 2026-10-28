/** Every value the code may write to activity_log.event_type. Single source
 *  of truth for the DB CHECK constraint (migration 00053) — pinned by
 *  `src/lib/scan/db-check-contract.test.ts`. */
export const ACTIVITY_EVENT_TYPES = [
  "scan_started",
  "scan_completed",
  "signal_detected",
  "signal_no_action",
  "position_opened",
  "position_closed",
  "stop_loss_hit",
  "take_profit_hit",
  "error",
  "pair_auto_paused",
  "daily_loss_halt",
  "portfolio_halt",
  "drift_halt",
  "divergence_halt",
  "live_order_placed",
  "live_order_failed",
  "live_order_closed",
  "live_close_failed",
  "live_order_close_failed",
  "scan_overdue",
  "broker_reconciliation_drift",
  "broker_realized_synced",
  "manage_tick",
  "cron_idle",
  "alpha_decay_pause",
  "alpha_decay_tick",
  "wfo_rules_updated",
  "regime_route_switched",
  "dll_warning",
] as const;
export type ActivityEventType = (typeof ACTIVITY_EVENT_TYPES)[number];

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
