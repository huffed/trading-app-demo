"use client";

import { useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  triggerScan,
  closePosition,
  getPaperTradingStats,
  refreshPositionPrices,
} from "@/app/(dashboard)/algorithms/paper-trading-actions";
import { createClient } from "@/lib/supabase/client";
import type { ActivityFilters, ActivityLogEntry } from "@/types/activity";
import type { PaperPosition, PositionFilters } from "@/types/position";

const POSITIONS_KEY = ["paper-positions"];
const ACTIVITY_KEY = ["activity-log"];
const PAPER_STATS_KEY = ["paper-trading-stats"];

export function useOpenPositions(algorithmId?: string) {
  return useQuery({
    queryKey: [...POSITIONS_KEY, "open", algorithmId],
    queryFn: async () => {
      const supabase = createClient();
      let query = supabase
        .from("paper_positions")
        .select("*")
        .eq("status", "open")
        .order("opened_at", { ascending: false });

      if (algorithmId) query = query.eq("algorithm_id", algorithmId);

      const { data, error } = await query;
      if (error) throw error;
      return (data ?? []) as PaperPosition[];
    },
  });
}

/**
 * Fetch every closed position within the last `days` (default 30). Pass
 * `algorithmId` to scope to one algorithm, or omit for portfolio-wide
 * (used by the dashboard's hero equity curve). Used for charts that
 * need the full series — pagination doesn't fit a cumulative-pnl curve.
 * Capped server-side at 1000 rows to keep payload bounded.
 */
export function useClosedPositionsWindow(algorithmId: string | undefined, days = 30) {
  return useQuery({
    queryKey: [...POSITIONS_KEY, "closed-window", algorithmId ?? "portfolio", days],
    queryFn: async () => {
      const since = new Date(Date.now() - days * 86_400_000).toISOString();
      const supabase = createClient();
      let query = supabase
        .from("paper_positions")
        .select("*")
        .eq("status", "closed")
        .gte("closed_at", since)
        .order("closed_at", { ascending: true })
        .limit(1000);
      if (algorithmId) query = query.eq("algorithm_id", algorithmId);
      const { data, error } = await query;
      if (error) throw error;
      return (data ?? []) as PaperPosition[];
    },
  });
}

export function useClosedPositions(algorithmId?: string, page = 1, perPage = 25) {
  return useQuery({
    queryKey: [...POSITIONS_KEY, "closed", algorithmId, page, perPage],
    queryFn: async () => {
      const supabase = createClient();
      let query = supabase
        .from("paper_positions")
        .select("*", { count: "exact" })
        .eq("status", "closed")
        .order("closed_at", { ascending: false });

      if (algorithmId) query = query.eq("algorithm_id", algorithmId);

      const from = (page - 1) * perPage;
      const to = from + perPage - 1;
      query = query.range(from, to);

      const { data, error, count } = await query;
      if (error) throw error;

      return {
        positions: (data ?? []) as PaperPosition[],
        total: count ?? 0,
        page,
        perPage,
      };
    },
  });
}

export function usePositionsList(filters: PositionFilters = {}, page = 1, perPage = 25) {
  return useQuery({
    queryKey: [...POSITIONS_KEY, filters, page, perPage],
    queryFn: async () => {
      const supabase = createClient();
      let query = supabase
        .from("paper_positions")
        .select("*", { count: "exact" })
        .order("opened_at", { ascending: false });

      if (filters.status) query = query.eq("status", filters.status);
      if (filters.algorithm_id) query = query.eq("algorithm_id", filters.algorithm_id);
      if (filters.ticker) query = query.ilike("ticker", `%${filters.ticker}%`);

      const from = (page - 1) * perPage;
      const to = from + perPage - 1;
      query = query.range(from, to);

      const { data, error, count } = await query;
      if (error) throw error;

      return {
        positions: (data ?? []) as PaperPosition[],
        total: count ?? 0,
        page,
        perPage,
      };
    },
  });
}

export function useClosePosition() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (positionId: string) => closePosition(positionId),
    onSuccess: (result) => {
      if (result.success) {
        queryClient.invalidateQueries({ queryKey: POSITIONS_KEY });
        queryClient.invalidateQueries({ queryKey: ACTIVITY_KEY });
        queryClient.invalidateQueries({ queryKey: PAPER_STATS_KEY });
      }
    },
  });
}

export function useTriggerScan() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { algorithmId?: string; force?: boolean } = {}) =>
      triggerScan(input.algorithmId, { force: input.force }),
    onSuccess: (result) => {
      if (result.success) {
        queryClient.invalidateQueries({ queryKey: POSITIONS_KEY });
        queryClient.invalidateQueries({ queryKey: ACTIVITY_KEY });
        queryClient.invalidateQueries({ queryKey: PAPER_STATS_KEY });
        queryClient.invalidateQueries({ queryKey: ["algorithms"] });
      }
    },
  });
}

export function useActivityLog(filters: ActivityFilters = {}, page = 1, perPage = 20) {
  return useQuery({
    queryKey: [...ACTIVITY_KEY, filters, page, perPage],
    queryFn: async () => {
      const supabase = createClient();
      let query = supabase
        .from("activity_log")
        .select("*", { count: "exact" })
        .order("created_at", { ascending: false });

      if (filters.algorithm_id) query = query.eq("algorithm_id", filters.algorithm_id);
      if (filters.ticker) query = query.eq("ticker", filters.ticker);
      if (filters.event_type) query = query.eq("event_type", filters.event_type);
      if (filters.date_from) query = query.gte("created_at", filters.date_from);
      if (filters.date_to) query = query.lte("created_at", filters.date_to);

      const from = (page - 1) * perPage;
      const to = from + perPage - 1;
      query = query.range(from, to);

      const { data, error, count } = await query;
      if (error) throw error;

      return {
        entries: (data ?? []) as ActivityLogEntry[],
        total: count ?? 0,
        page,
        perPage,
      };
    },
  });
}

export function usePaperTradingStats() {
  return useQuery({
    queryKey: PAPER_STATS_KEY,
    // Paper trading rollup — total positions, win-rate, etc. Aligned with
    // dashboard-stats at 60s so the two cards never disagree on the same
    // page.
    staleTime: 60_000,
    queryFn: async () => {
      const result = await getPaperTradingStats();
      if (!result.success) throw new Error(result.error);
      return result.data;
    },
  });
}

/**
 * Auto-refreshes open position prices every 60s.
 * Only runs when there are open positions. Updates DB prices,
 * then invalidates queries so the UI reflects new P&L.
 */
export function useAutoRefreshPrices(algorithmId?: string, enabled = true) {
  const queryClient = useQueryClient();
  const refreshing = useRef(false);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const interval = setInterval(async () => {
      if (refreshing.current) {
        return;
      }
      refreshing.current = true;
      try {
        const result = await refreshPositionPrices(algorithmId);
        if (result.success && result.data > 0) {
          queryClient.invalidateQueries({ queryKey: POSITIONS_KEY });
          queryClient.invalidateQueries({ queryKey: PAPER_STATS_KEY });
        }
      } finally {
        refreshing.current = false;
      }
    }, 60_000);

    return () => clearInterval(interval);
  }, [algorithmId, enabled, queryClient]);
}
