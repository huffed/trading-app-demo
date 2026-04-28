/**
 * Pair-quality evaluator — computes per-(algorithm, ticker) trade stats
 * and decides whether a pair should be auto-paused.
 *
 * Motivation: on testing 3, GBP/JPY produced 0 wins out of 8 trades over
 * a year — clearly broken for that strategy. Removing it improved 1y
 * return from $22k to $33k. This module automates that decision so the
 * system flags chronic-underperformers without manual intervention.
 *
 * Heuristic: prune when a pair has at least `minTrades` closed trades AND
 * the win rate is below `wrThreshold`. Both are deliberately conservative
 * — we'd rather keep a marginal pair too long than yank a winning one
 * after a small unlucky stretch.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export interface PairQualityConfig {
  /** Minimum closed-trade sample before pruning is allowed. */
  minTrades: number;
  /** Win-rate floor (0..1). At or below this triggers prune. */
  wrThreshold: number;
}

export const DEFAULT_PAIR_QUALITY_CONFIG: PairQualityConfig = {
  minTrades: 8,
  wrThreshold: 0.3,
};

export interface PairStats {
  ticker: string;
  trades: number;
  wins: number;
  losses: number;
  win_rate: number;
  net_pnl: number;
  avg_win: number;
  avg_loss: number;
}

interface PaperRow {
  ticker: string;
  realized_pnl: number | null;
}

/** Query closed trades for one (algo, ticker) pair and roll them into a
 *  PairStats record. Returns null when no trades exist — caller treats
 *  that as "no decision" rather than "low quality". */
export async function getPairStats(
  supabase: SupabaseClient,
  algorithmId: string,
  ticker: string
): Promise<PairStats | null> {
  const { data, error } = await supabase
    .from("paper_positions")
    .select("ticker, realized_pnl")
    .eq("algorithm_id", algorithmId)
    .eq("ticker", ticker)
    .eq("status", "closed")
    .not("realized_pnl", "is", null);
  if (error || !data || data.length === 0) return null;
  return aggregateStats(ticker, data as PaperRow[]);
}

/** Same as getPairStats but in one round-trip across all watchlisted
 *  pairs of an algorithm. */
export async function getAllPairStats(
  supabase: SupabaseClient,
  algorithmId: string
): Promise<Map<string, PairStats>> {
  const out = new Map<string, PairStats>();
  const { data, error } = await supabase
    .from("paper_positions")
    .select("ticker, realized_pnl")
    .eq("algorithm_id", algorithmId)
    .eq("status", "closed")
    .not("realized_pnl", "is", null);
  if (error || !data) return out;
  const byTicker = new Map<string, PaperRow[]>();
  for (const row of data as PaperRow[]) {
    const list = byTicker.get(row.ticker);
    if (list) list.push(row);
    else byTicker.set(row.ticker, [row]);
  }
  for (const [ticker, rows] of byTicker) out.set(ticker, aggregateStats(ticker, rows));
  return out;
}

function aggregateStats(ticker: string, rows: PaperRow[]): PairStats {
  let wins = 0;
  let losses = 0;
  let winPnl = 0;
  let lossPnl = 0;
  for (const r of rows) {
    const pnl = r.realized_pnl ?? 0;
    if (pnl > 0) {
      wins++;
      winPnl += pnl;
    } else if (pnl < 0) {
      losses++;
      lossPnl += pnl;
    }
  }
  const total = wins + losses;
  return {
    ticker,
    trades: total,
    wins,
    losses,
    win_rate: total > 0 ? wins / total : 0,
    net_pnl: winPnl + lossPnl,
    avg_win: wins > 0 ? winPnl / wins : 0,
    avg_loss: losses > 0 ? lossPnl / losses : 0,
  };
}

export interface PruneDecision {
  prune: boolean;
  reason: string | null;
}

export function shouldPrune(
  stats: PairStats | null,
  config: PairQualityConfig = DEFAULT_PAIR_QUALITY_CONFIG
): PruneDecision {
  if (!stats || stats.trades < config.minTrades) {
    return { prune: false, reason: null };
  }
  if (stats.win_rate <= config.wrThreshold) {
    const wrPct = (stats.win_rate * 100).toFixed(0);
    return {
      prune: true,
      reason: `${stats.wins}/${stats.trades} WR (${wrPct}%) ≤ threshold ${(
        config.wrThreshold * 100
      ).toFixed(0)}%, net $${stats.net_pnl.toFixed(0)}`,
    };
  }
  return { prune: false, reason: null };
}

/**
 * Sweep an algorithm's watchlist, evaluate each ticker, and auto-pause
 * the ones that fail. Returns one entry per ticker evaluated so callers
 * can log/report what changed.
 */
export async function evaluateAndPrune(
  supabase: SupabaseClient,
  algorithmId: string,
  config: PairQualityConfig = DEFAULT_PAIR_QUALITY_CONFIG
): Promise<{ ticker: string; stats: PairStats | null; pruned: boolean; reason: string | null }[]> {
  const { data: watchlist } = await supabase
    .from("algorithm_watchlist")
    .select("id, ticker, auto_paused")
    .eq("algorithm_id", algorithmId);
  const rows = (watchlist ?? []) as { id: string; ticker: string; auto_paused: boolean }[];
  if (rows.length === 0) return [];

  const allStats = await getAllPairStats(supabase, algorithmId);
  const results: { ticker: string; stats: PairStats | null; pruned: boolean; reason: string | null }[] =
    [];

  for (const row of rows) {
    if (row.auto_paused) {
      // Already paused — skip re-evaluating; manual unpause is required
      // before the algo can trade this ticker again.
      results.push({ ticker: row.ticker, stats: allStats.get(row.ticker) ?? null, pruned: true, reason: "already_paused" });
      continue;
    }
    const stats = allStats.get(row.ticker) ?? null;
    const decision = shouldPrune(stats, config);
    if (decision.prune) {
      await supabase
        .from("algorithm_watchlist")
        .update({
          auto_paused: true,
          auto_paused_at: new Date().toISOString(),
          auto_paused_reason: decision.reason,
        })
        .eq("id", row.id);
    }
    results.push({
      ticker: row.ticker,
      stats,
      pruned: decision.prune,
      reason: decision.reason,
    });
  }
  return results;
}
