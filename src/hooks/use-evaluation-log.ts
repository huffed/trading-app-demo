"use client";

import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";

/** Engine-side evaluation trail for one algorithm — the deterministic
 *  counterpart of the LLM decisions feed. Sourced from activity_log:
 *  gate refusals (incl. market_state_gate verdicts), condition misses,
 *  entries/exits, broker mirror events, halts. For non-LLM library
 *  algos this IS the per-tick decision display; for LLM algos it shows
 *  what the engine did around each call. */
export interface EvaluationLogRow {
  id: string;
  event_type: string;
  ticker: string | null;
  details: Record<string, unknown> | null;
  created_at: string;
}

/** Per-evaluation story only — scan/manage heartbeat noise excluded. */
export const EVALUATION_EVENT_TYPES = [
  "signal_no_action",
  "signal_detected",
  "position_opened",
  "position_closed",
  "stop_loss_hit",
  "take_profit_hit",
  "live_order_placed",
  "live_order_failed",
  "live_order_closed",
  "live_close_failed",
  "daily_loss_halt",
  "divergence_halt",
  "drift_halt",
  "portfolio_halt",
  "pair_auto_paused",
  "broker_reconciliation_drift",
  "error",
] as const;

const EVALUATION_LOG_KEY = ["evaluation-log"] as const;

export function useEvaluationLog(algorithmId: string, limit = 30) {
  return useQuery({
    queryKey: [...EVALUATION_LOG_KEY, algorithmId, limit],
    queryFn: async (): Promise<{ entries: EvaluationLogRow[] }> => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("activity_log")
        .select("id, event_type, ticker, details, created_at")
        .eq("algorithm_id", algorithmId)
        .in("event_type", [...EVALUATION_EVENT_TYPES])
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) throw error;
      return {
        entries: (data ?? []).map((r) => ({
          ...r,
          // Column is nullable in the schema but the engine always stamps it.
          created_at: r.created_at ?? "",
          details: (r.details as Record<string, unknown> | null) ?? null,
        })),
      };
    },
    refetchInterval: 60_000,
  });
}
