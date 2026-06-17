"use client";

import { useQuery } from "@tanstack/react-query";
import { getLivePriceAction } from "@/app/(dashboard)/chart/actions";

const REFETCH_INTERVAL_MS = 5_000;

/** Poll OANDA every 5 seconds for the latest mid-price of `ticker`.
 *  Pauses automatically when the browser tab is in the background via
 *  React Query's refetchIntervalInBackground=false default. */
export function useLivePrice(ticker: string) {
  return useQuery({
    queryKey: ["live-price", ticker],
    queryFn: async () => {
      const r = await getLivePriceAction(ticker);
      if (!r.success) throw new Error(r.error);
      return r.data;
    },
    refetchInterval: REFETCH_INTERVAL_MS,
    refetchIntervalInBackground: false,
    enabled: ticker.length > 0,
    // Don't retry indefinitely on a flaky tick — let the next interval
    // try again so we don't spam OANDA on a transient failure.
    retry: 1,
  });
}
