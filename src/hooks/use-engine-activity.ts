"use client";

import { useQuery } from "@tanstack/react-query";
import { getEngineActivityAction } from "@/app/(dashboard)/reports/actions";

/**
 * Engine activity for the /reports page. Cohort report companion — when
 * zero trades have closed yet (e.g. paper algos in the first 30 days),
 * this is the weekly review surface.
 *
 * Window defaults to 7 days (operator weekly cadence). 60s staleTime
 * is plenty — activity_log is appended by scan-cron every 15 min so
 * 60s avoids re-querying on incidental focus changes.
 */
export function useEngineActivity(days = 7) {
  return useQuery({
    queryKey: ["engine-activity", days],
    staleTime: 60_000,
    queryFn: async () => {
      const result = await getEngineActivityAction(days);
      if (!result.success) throw new Error(result.error);
      return result.data;
    },
  });
}
