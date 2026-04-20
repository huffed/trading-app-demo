export type AssetClass = "equity" | "option" | "future" | "forex" | "crypto";
export type TradeSide = "long" | "short";
export type TradeStatus = "open" | "closed";

export interface Trade {
  id: string;
  user_id: string;
  symbol: string;
  asset_class: AssetClass;
  side: TradeSide;
  quantity: number;
  entry_price: number;
  exit_price: number | null;
  entry_date: string;
  exit_date: string | null;
  commission: number;
  fees: number;
  strategy: string | null;
  tags: string[];
  notes: string | null;
  status: TradeStatus;
  currency: string;
  realized_pnl: number | null;
  created_at: string;
  updated_at: string;
}

export type TradeInsert = Omit<
  Trade,
  "id" | "user_id" | "realized_pnl" | "created_at" | "updated_at"
>;

export type TradeUpdate = Partial<TradeInsert>;

export interface TradeFilters {
  status?: TradeStatus;
  side?: TradeSide;
  asset_class?: AssetClass;
  symbol?: string;
  strategy?: string;
  date_from?: string;
  date_to?: string;
}
