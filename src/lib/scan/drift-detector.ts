/**
 * Performance-drift detector. Compares recent live trade stats to the
 * algorithm's backtested baseline; flags when recent performance has
 * decayed enough to suggest the strategy's edge no longer holds in the
 * current regime.
 *
 * Tier 1 (foundation) of Phase 7 learning loop. The next iterations
 * will auto-tune parameters in response to drift; this version just
 * detects + logs + (optionally) halts so a human can review before
 * the algorithm continues to bleed.
 *
 * Heuristic:
 *   - Need at least minTrades closed live trades to evaluate.
 *   - "warn" when recent WR is ≥ 15 pp below backtest baseline.
 *   - "halt" when recent WR is ≥ 25 pp below baseline OR recent net
 *     P&L is negative while backtest baseline was positive.
 *
 * Conservative thresholds — better to skip a flagging on a small
 * unlucky run than to halt prematurely.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { BacktestResults } from "@/types/algorithm";

export type DriftSeverity = "none" | "warn" | "halt";

export interface DriftCheckResult {
  severity: DriftSeverity;
  reason: string;
  recent: { trades: number; win_rate: number; net_pnl: number };
  baseline: { win_rate: number | null; total_return: number | null };
}

interface ClosedRow {
  realized_pnl: number | null;
}

const DEFAULT_MIN_TRADES = 10;
const DEFAULT_LOOKBACK_TRADES = 25;
const WARN_WR_DROP_PP = 15;
const HALT_WR_DROP_PP = 25;

export interface DriftConfig {
  minTrades: number;
  lookbackTrades: number;
}

export const DEFAULT_DRIFT_CONFIG: DriftConfig = {
  minTrades: DEFAULT_MIN_TRADES,
  lookbackTrades: DEFAULT_LOOKBACK_TRADES,
};

export async function detectDrift(
  supabase: SupabaseClient,
  algorithmId: string,
  baseline: BacktestResults | null,
  config: DriftConfig = DEFAULT_DRIFT_CONFIG
): Promise<DriftCheckResult> {
  const empty: DriftCheckResult = {
    severity: "none",
    reason: "Insufficient live history to evaluate drift",
    recent: { trades: 0, win_rate: 0, net_pnl: 0 },
    baseline: {
      win_rate: baseline?.win_rate ?? null,
      total_return: baseline?.total_return ?? null,
    },
  };
  if (!baseline) {
    return { ...empty, reason: "No backtest baseline saved on the algorithm" };
  }

  const { data } = await supabase
    .from("paper_positions")
    .select("realized_pnl")
    .eq("algorithm_id", algorithmId)
    .eq("status", "closed")
    .not("realized_pnl", "is", null)
    .order("closed_at", { ascending: false })
    .limit(config.lookbackTrades);
  const rows = (data ?? []) as ClosedRow[];
  const trades = rows.length;
  if (trades < config.minTrades) {
    return {
      ...empty,
      reason: `Only ${trades} closed live trades (need ≥${config.minTrades})`,
      recent: { trades, win_rate: 0, net_pnl: 0 },
    };
  }

  let wins = 0;
  let netPnl = 0;
  for (const r of rows) {
    const pnl = r.realized_pnl ?? 0;
    if (pnl > 0) wins++;
    netPnl += pnl;
  }
  const recentWr = (wins / trades) * 100;
  const baseWr = baseline.win_rate;
  const wrDrop = baseWr - recentWr;

  // Halt: severe WR drop OR sign flip on net P&L vs backtest direction.
  if (wrDrop >= HALT_WR_DROP_PP) {
    return {
      severity: "halt",
      reason: `Severe WR drift: recent ${recentWr.toFixed(0)}% vs baseline ${baseWr.toFixed(0)}% (-${wrDrop.toFixed(0)}pp over ${trades} trades)`,
      recent: { trades, win_rate: recentWr, net_pnl: netPnl },
      baseline: { win_rate: baseWr, total_return: baseline.total_return },
    };
  }
  if (baseline.total_return > 0 && netPnl < 0 && trades >= config.minTrades) {
    return {
      severity: "halt",
      reason: `Sign flip: backtest baseline +$${baseline.total_return.toFixed(0)} but recent ${trades} trades net $${netPnl.toFixed(0)}`,
      recent: { trades, win_rate: recentWr, net_pnl: netPnl },
      baseline: { win_rate: baseWr, total_return: baseline.total_return },
    };
  }
  if (wrDrop >= WARN_WR_DROP_PP) {
    return {
      severity: "warn",
      reason: `WR drift: recent ${recentWr.toFixed(0)}% vs baseline ${baseWr.toFixed(0)}% (-${wrDrop.toFixed(0)}pp)`,
      recent: { trades, win_rate: recentWr, net_pnl: netPnl },
      baseline: { win_rate: baseWr, total_return: baseline.total_return },
    };
  }

  return {
    severity: "none",
    reason: `Within range: recent ${recentWr.toFixed(0)}% WR vs baseline ${baseWr.toFixed(0)}% over ${trades} trades`,
    recent: { trades, win_rate: recentWr, net_pnl: netPnl },
    baseline: { win_rate: baseWr, total_return: baseline.total_return },
  };
}

/**
 * Disable live trading on the algorithm and log the halt. Caller
 * decides whether to also flatten open positions — drift halts are
 * usually a "stop new entries, let existing positions play out"
 * stance, distinct from DLL force-close.
 */
export async function executeDriftHalt(
  supabase: SupabaseClient,
  userId: string,
  algorithmId: string,
  result: DriftCheckResult
): Promise<void> {
  await supabase
    .from("algorithms")
    .update({ live_trading_enabled: false })
    .eq("id", algorithmId);
  await supabase.from("activity_log").insert({
    user_id: userId,
    algorithm_id: algorithmId,
    event_type: "drift_halt",
    details: {
      severity: result.severity,
      reason: result.reason,
      recent: result.recent,
      baseline: result.baseline,
    },
  });
}
