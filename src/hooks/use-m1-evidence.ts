"use client";

import { useQuery } from "@tanstack/react-query";
import { getM1EvidenceAction } from "@/app/(dashboard)/reports/actions";

/**
 * M1 evidence tracker for the /reports M1 tab (G.8 gate comparator).
 *
 * 5-minute staleTime — the statistic moves at paper-trade-close cadence
 * (4h bars), not second-by-second.
 */
export function useM1Evidence() {
  return useQuery({
    queryKey: ["m1-evidence"],
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const result = await getM1EvidenceAction();
      if (!result.success) throw new Error(result.error);
      return result.data;
    },
  });
}
