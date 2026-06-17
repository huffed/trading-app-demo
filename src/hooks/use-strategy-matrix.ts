"use client";

import { useQuery } from "@tanstack/react-query";
import { getStrategyMatrixAction } from "@/app/(dashboard)/performance/actions";

/** Strategy performance matrix for the /performance grid + chart.
 *  60s staleTime — backtest_results changes only on deploy/backfill. */
export function useStrategyMatrix() {
  return useQuery({
    queryKey: ["strategy-matrix"],
    staleTime: 60_000,
    queryFn: async () => {
      const result = await getStrategyMatrixAction();
      if (!result.success) throw new Error(result.error);
      return result.data;
    },
  });
}
