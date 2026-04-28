"use client";

import { useQuery } from "@tanstack/react-query";
import { getFtmoCompliance } from "@/app/(dashboard)/algorithms/ftmo-compliance-actions";
import type { FtmoCompliance } from "@/types/ftmo-compliance";

const KEY = ["ftmo-compliance"];

/**
 * Live FTMO compliance snapshot for an algorithm. Refetches every 30s so
 * the gauges feel "live" without overwhelming Supabase. Cheap aggregation
 * over a few small queries — safe to refetch frequently.
 */
export function useFtmoCompliance(algorithmId: string) {
  return useQuery<FtmoCompliance | null>({
    queryKey: [...KEY, algorithmId],
    queryFn: async () => {
      const r = await getFtmoCompliance(algorithmId);
      return r.success ? r.data : null;
    },
    // Live FTMO compliance gauge — equity, daily P&L, halt state. Tight
    // refresh because traders watch this card during open positions; a
    // stale value can mean trading past the daily-loss limit on screen
    // before they see the halt fire. 15s stale + 30s background refetch
    // keeps the panel current without hammering the action.
    refetchInterval: 30_000,
    staleTime: 15_000,
    enabled: !!algorithmId,
  });
}
