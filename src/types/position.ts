export type PositionStatus = "open" | "closed";
export type ExitReason = "stop_loss" | "take_profit" | "exit_signal" | "manual";

export interface EntryReason {
  conditions_met: {
    type: string;
    indicator?: string;
    metric?: string;
    operator: string;
    value: number;
  }[];
  signal_result?: {
    signal: string;
    confidence: number;
    reasoning: string;
  };
}

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
  take_profit_price: number | null;
  status: PositionStatus;
  // Live broker mirror — populated only when algorithm has live trading on.
  broker_order_id?: string | null;
  broker_position_id?: string | null;
  broker_fill_price?: number | null;
  broker_close_id?: string | null;
  broker_close_price?: number | null;
  broker_error?: string | null;
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
