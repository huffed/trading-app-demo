"use client";

import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";

/** Stale threshold matching the GitHub Actions dead-man-switch in
 *  .github/workflows/dead-man.yml — 45 minutes since the last manage-cron
 *  tick is treated as "the local Mac cron is dead". */
export const HEARTBEAT_STALE_MS = 45 * 60 * 1000;

/** Read the latest manage-cron tick timestamp via the
 *  `last_manage_tick()` SECURITY DEFINER RPC. Refetched every minute so
 *  the dashboard rail surfaces silent-outage risk without manual reload. */
export function useHeartbeat() {
  return useQuery({
    queryKey: ["heartbeat"],
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    queryFn: async (): Promise<string | null> => {
      const supabase = createClient();
      const { data, error } = await supabase.rpc("last_manage_tick");
      if (error) throw error;
      return (data as string | null) ?? null;
    },
  });
}
