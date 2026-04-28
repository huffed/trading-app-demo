"use client";

import { useQuery } from "@tanstack/react-query";
import { getStrategyStats } from "@/app/(dashboard)/algorithms/strategy-stats-actions";
import type { StrategyStats } from "@/types/strategy-stats";

const STRATEGY_STATS_KEY = ["strategy-stats"];

/**
 * Fetch aggregated condition / per-pair stats for an algorithm. Refetches
 * cheaply (in-memory aggregation over closed positions) so we can keep the
 * data fresh without coordination — staleTime is the only knob.
 */
export function useStrategyStats(algorithmId: string) {
  return useQuery<StrategyStats | null>({
    queryKey: [...STRATEGY_STATS_KEY, algorithmId],
    queryFn: async () => {
      const r = await getStrategyStats(algorithmId);
      return r.success ? r.data : null;
    },
    // Aggregated condition / per-pair stats. Updates as positions close,
    // which can happen multiple times per minute during active scans —
    // tighter staleTime than the dashboard so users see fresh win-rates
    // without a manual refresh.
    staleTime: 30_000,
    enabled: !!algorithmId,
  });
}
