export type JournalEmotion =
  | "confident"
  | "disciplined"
  | "calm"
  | "neutral"
  | "anxious"
  | "fearful"
  | "greedy"
  | "impulsive"
  | "frustrated";

export type JournalEntryType =
  | "pre-market"
  | "reflection"
  | "review"
  | "lesson"
  | "strategy-idea";

export interface JournalEntry {
  id: string;
  user_id: string;
  title: string;
  content: string;
  emotion: JournalEmotion;
  self_rating: number | null;
  tags: string[];
  entry_type: JournalEntryType;
  linked_trade_ids: string[];
  ai_analysis: string | null;
  ai_analyzed_at: string | null;
  created_at: string;
  updated_at: string;
}

export type JournalEntryInsert = Omit<
  JournalEntry,
  "id" | "user_id" | "ai_analysis" | "ai_analyzed_at" | "created_at" | "updated_at"
>;

export type JournalEntryUpdate = Partial<JournalEntryInsert>;

export interface JournalFilters {
  emotion?: JournalEmotion;
  entry_type?: JournalEntryType;
  date_from?: string;
  date_to?: string;
  search?: string;
}
