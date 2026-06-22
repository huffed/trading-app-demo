"use client";

import { useQuery } from "@tanstack/react-query";
import { getCohortReportAction } from "@/app/(dashboard)/reports/actions";
import type { CohortReportOptions } from "@/lib/cohort/cohort-report";

/**
 * Cohort report for the /reports Cohort tab.
 * SG.6 (2026-06-22 NIGHT LATE).
 *
 * 5-minute staleTime — cohort stats shift at trade-close cadence;
 * intra-day cron + manual review don't need second-by-second freshness.
 */
export function useCohortReport(opts: CohortReportOptions = {}) {
  return useQuery({
    queryKey: ["cohort-report", opts.days ?? 14, opts.source ?? "live", opts.minN ?? 5],
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const result = await getCohortReportAction(opts);
      if (!result.success) throw new Error(result.error);
      return result.data;
    },
  });
}
