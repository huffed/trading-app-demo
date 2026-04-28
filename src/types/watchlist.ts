export type WatchlistAddedBy = "user" | "ai" | "csv";

export interface WatchlistItem {
  id: string;
  user_id: string;
  algorithm_id: string;
  ticker: string;
  name: string;
  added_by: WatchlistAddedBy;
  notes: string | null;
  backtest_metrics: Record<string, unknown> | null;
  auto_paused: boolean;
  auto_paused_at: string | null;
  auto_paused_reason: string | null;
  created_at: string;
  updated_at: string;
}

export type WatchlistItemInsert = Pick<
  WatchlistItem,
  "algorithm_id" | "ticker" | "name" | "added_by" | "notes"
>;

export interface DiscoverySuggestion {
  ticker: string;
  name: string;
  sector: string;
  reasoning: string;
}
