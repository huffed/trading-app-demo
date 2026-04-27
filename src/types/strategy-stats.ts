/**
 * Aggregated stats for closed paper positions, derived from the
 * `entry_reason.conditions_met` JSONB blob already written on each row.
 *
 * The signature is a stable, human-readable description of which entry
 * conditions fired together. We aggregate by signature so the user can
 * see "RSI<50 + EMA12>0 wins 70% of the time on EUR/JPY" — the data
 * needed to drop dead-weight rules and emphasise what's working.
 */

export interface ConditionStatRow {
  /** Stable human-readable signature, e.g. "RSI<50, EMA12>0, BB_upper>0". */
  signature: string;
  /** Total trades that matched this exact signature. */
  trades: number;
  wins: number;
  losses: number;
  win_rate_pct: number;
  /** Sum of realised_pnl in USD across the trades. */
  total_pnl_usd: number;
  avg_pnl_usd: number;
  /** Per-pair breakdown so the user can see "this combo wins on EUR/JPY but
   *  loses on GBP/JPY" without leaving the row. */
  per_pair: Record<string, { trades: number; wins: number; pnl_usd: number }>;
}

export interface PairStatRow {
  ticker: string;
  trades: number;
  wins: number;
  losses: number;
  win_rate_pct: number;
  total_pnl_usd: number;
  avg_pnl_usd: number;
}

export interface StrategyStats {
  /** Closed trades that contributed to the aggregation. */
  total_closed_trades: number;
  /** Closed trades excluded (no entry_reason / unparseable / open). */
  excluded_trades: number;
  /** Aggregated by condition signature, sorted by trade count desc. */
  by_signature: ConditionStatRow[];
  /** Aggregated by ticker, sorted by trade count desc. */
  by_pair: PairStatRow[];
}
