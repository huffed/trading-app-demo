"use client";

import { useQuery } from "@tanstack/react-query";
import { getDriftSummaryAction } from "@/app/(dashboard)/reports/actions";
import type { DriftSummaryOptions } from "@/lib/cohort/drift-summary";

/**
 * Drift summary for the /reports Drift tab. SG.5 closure
 * (2026-06-22 NIGHT LATE).
 *
 * 5-minute staleTime — drift severity shifts at trade-close cadence,
 * doesn't need second-by-second refresh.
 */
export function useDriftSummary(opts: DriftSummaryOptions = {}) {
  return useQuery({
    queryKey: ["drift-summary", opts.history_days ?? 30, opts.event_limit ?? 50],
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const result = await getDriftSummaryAction(opts);
      if (!result.success) throw new Error(result.error);
      return result.data;
    },
  });
}
