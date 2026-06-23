"use client";

import { useQuery } from "@tanstack/react-query";
import { getAlphaDecaySummaryAction } from "@/app/(dashboard)/reports/actions";

/**
 * G.4 alpha-decay summary for the /reports Drift tab. Pure-read via the
 * server action — same classifier the daily cron uses, never mutates.
 *
 * 5-minute staleTime — decay severity shifts only on new closed positions
 * (which arrive at scan-completion cadence), so per-minute refresh
 * is unnecessary.
 */
export function useAlphaDecaySummary() {
  return useQuery({
    queryKey: ["alpha-decay-summary"],
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const result = await getAlphaDecaySummaryAction();
      if (!result.success) throw new Error(result.error);
      return result.data;
    },
  });
}
