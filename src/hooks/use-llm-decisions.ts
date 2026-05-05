"use client";

import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";

export interface LlmDecisionRow {
  id: string;
  algorithm_id: string;
  bar_date: string;
  prompt_version: string;
  provider: string;
  model: string;
  regime: "HH" | "LH" | "RANGING" | "n/a";
  decision: "enter_long" | "enter_short" | "hold" | "exit";
  confidence: number | null;
  reasoning: string | null;
  context: Record<string, unknown> | null;
  had_position: "flat" | "long" | "short";
  paper_position_id: string | null;
  trade_outcome: {
    r_multiple?: number;
    exit_reason?: string;
    realized_pnl?: number;
    side?: "long" | "short";
    entry_price?: number;
    exit_price?: number;
    exit_date?: string;
  } | null;
  source: "live" | "backtest" | "walk_forward";
  created_at: string;
}

const LLM_DECISIONS_KEY = ["llm-decisions"] as const;

/** Latest N decisions for an algorithm, newest first. Foundation for the
 *  Decisions tab on the algorithm detail page. RLS scopes to the
 *  authenticated user. */
export function useLlmDecisions(
  algorithmId: string,
  page = 1,
  perPage = 25,
  filters: { decision?: string; regime?: string; source?: string } = {}
) {
  return useQuery({
    queryKey: [...LLM_DECISIONS_KEY, algorithmId, page, perPage, filters],
    queryFn: async () => {
      const supabase = createClient();
      // Sort by `created_at` (when the row was inserted server-side via
      // postgres now()) rather than `bar_date` (the bar the LLM was
      // reasoning about). Historical rows from before the
      // Twelve Data timezone fix have Sydney-stamped bar_dates that
      // sort as "future" UTC, pushing them above genuinely fresh
      // decisions. created_at is timezone-immune.
      let query = supabase
        .from("llm_decisions")
        .select("*", { count: "exact" })
        .eq("algorithm_id", algorithmId)
        .order("created_at", { ascending: false });

      if (filters.decision) query = query.eq("decision", filters.decision);
      if (filters.regime) query = query.eq("regime", filters.regime);
      if (filters.source) query = query.eq("source", filters.source);

      const from = (page - 1) * perPage;
      const to = from + perPage - 1;
      query = query.range(from, to);

      const { data, error, count } = await query;
      if (error) throw error;

      return {
        entries: (data ?? []) as LlmDecisionRow[],
        total: count ?? 0,
        page,
        perPage,
      };
    },
  });
}
