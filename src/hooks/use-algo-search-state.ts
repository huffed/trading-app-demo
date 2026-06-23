"use client";

import { useQuery } from "@tanstack/react-query";
import { getAlgoSearchStateAction } from "@/app/(dashboard)/reports/actions";

/**
 * Algorithm-search state for the /reports Search tab.
 *
 * 60-second staleTime — the underlying source is `algorithms.backtest_results`
 * which only changes when the operator runs the sweep (manual, not on a
 * cadence). Faster polling would burn bandwidth for no signal change.
 */
export function useAlgoSearchState() {
  return useQuery({
    queryKey: ["algo-search-state"],
    staleTime: 60_000,
    queryFn: async () => {
      const result = await getAlgoSearchStateAction();
      if (!result.success) throw new Error(result.error);
      return result.data;
    },
  });
}
