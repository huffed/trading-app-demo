import type { EntryReason } from "@/lib/validators/position";

export type PositionStatus = "open" | "closed";
export type ExitReason =
  | "stop_loss"
  | "take_profit"
  | "exit_signal"
  | "manual"
  | "stagnant_no_excursion";

export type { EntryReason };

export interface PaperPosition {
  id: string;
  user_id: string;
  algorithm_id: string;
  ticker: string;
  side: "long" | "short";
  quantity: number;
  notional_value: number;
  entry_price: number;
  exit_price: number | null;
  current_price: number | null;
  opened_at: string;
  closed_at: string | null;
  unrealized_pnl: number;
  realized_pnl: number | null;
  entry_reason: EntryReason;
  exit_reason: ExitReason | null;
  stop_loss_price: number | null;
  /** Entry-time SL price, snapshotted at insert. Unlike stop_loss_price
   *  it is never mutated — `move_be` and any future trailing-SL logic
   *  only touch stop_loss_price. Read this when 1R must reflect the
   *  entry-to-SL distance the trade was opened with (R-multiple math,
   *  loss-magnitude gates). Null on rows opened before migration 00032. */
  initial_stop_loss_price: number | null;
  take_profit_price: number | null;
  status: PositionStatus;
  // Live broker mirror — populated only when algorithm has live trading on.
  broker_order_id?: string | null;
  broker_position_id?: string | null;
  broker_fill_price?: number | null;
  broker_close_id?: string | null;
  broker_close_price?: number | null;
  broker_error?: string | null;
  /** Broker-reported unrealized P&L, refreshed by the manage-positions
   *  cron each ~5min from the broker adapter's fetchPositions call.
   *  Includes the broker's bid/ask spread, commission, and swap — i.e.
   *  the actual number the broker dashboard shows. Null when the
   *  position has no broker mirror or the most recent fetch failed. */
  broker_unrealized_pnl?: number | null;
  broker_pnl_synced_at?: string | null;
  /** Timestamp at which broker truth (actual close fill + commission/swap-
   *  inclusive realized P&L) was written back to this row. NULL on a
   *  closed broker-mirrored position means the deferred reconciliation
   *  pass will keep retrying `fetchClosedDealForPosition` until the deal
   *  lands. NULL on paper-only or open rows is the steady state. */
  broker_realized_synced_at?: string | null;
  created_at: string;
  updated_at: string;
}

export type PaperPositionInsert = Omit<
  PaperPosition,
  | "id"
  | "user_id"
  | "exit_price"
  | "current_price"
  | "closed_at"
  | "unrealized_pnl"
  | "realized_pnl"
  | "exit_reason"
  | "status"
  | "created_at"
  | "updated_at"
>;

export interface PositionEvent {
  ticker: string;
  reason: string;
  pnl: number;
  price: number;
}

export interface PositionFilters {
  status?: PositionStatus;
  algorithm_id?: string;
  ticker?: string;
}
