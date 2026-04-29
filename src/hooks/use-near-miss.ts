"use client";

import { useQuery } from "@tanstack/react-query";
import { getNearMissFeed } from "@/app/(dashboard)/algorithms/near-miss-actions";

/**
 * Recent rejected entries for an algorithm. Defaults to last 48h —
 * matches the operator's typical daily-review window.
 */
export function useNearMissFeed(algorithmId: string, hours = 48) {
  return useQuery({
    queryKey: ["near-miss-feed", algorithmId, hours],
    enabled: !!algorithmId,
    staleTime: 30_000,
    queryFn: async () => {
      const r = await getNearMissFeed(algorithmId, hours);
      if (!r.success) throw new Error(r.error);
      return r.data;
    },
  });
}
