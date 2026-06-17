"use client";

import { useQuery } from "@tanstack/react-query";
import { getLiveMirrorEligibilityAction } from "@/app/(dashboard)/reports/actions";

/**
 * Live-mirror eligibility for the /reports Promotion Eligibility tab.
 * Returns per-paper-algo: days since deploy, closed trade count,
 * realized R, backtest expected R, variance, status (pending / eligible
 * / drift / no_backtest).
 *
 * 5-minute staleTime — eligibility shifts at trade-close cadence
 * (intra-day cron) so we don't need second-by-second freshness.
 */
export function useLiveMirrorEligibility() {
  return useQuery({
    queryKey: ["live-mirror-eligibility"],
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const result = await getLiveMirrorEligibilityAction();
      if (!result.success) throw new Error(result.error);
      return result.data;
    },
  });
}
