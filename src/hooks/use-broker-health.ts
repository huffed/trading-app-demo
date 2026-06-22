"use client";

import { useQuery } from "@tanstack/react-query";
import { getBrokerHealthAction } from "@/app/(dashboard)/reports/actions";
import type { BrokerHealthOptions } from "@/lib/cohort/broker-health";

/**
 * Broker health alerts for the /reports Brokers tab.
 * SG.9 closure (2026-06-22 NIGHT LATE).
 *
 * 5-minute staleTime — broker connection state shifts at the broker-
 * sync cadence (manage cron / scan cron / oanda-positioning cron) so
 * we don't need second-by-second freshness.
 */
export function useBrokerHealth(opts: BrokerHealthOptions = {}) {
  return useQuery({
    queryKey: [
      "broker-health",
      opts.stale_sync_threshold_hours ?? 6,
      opts.token_warn_days ?? 7,
      opts.snapshot_drift_threshold_pct ?? 5,
    ],
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const result = await getBrokerHealthAction(opts);
      if (!result.success) throw new Error(result.error);
      return result.data;
    },
  });
}
