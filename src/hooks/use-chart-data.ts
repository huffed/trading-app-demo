"use client";

import { useQuery } from "@tanstack/react-query";
import {
  getChartDataAction,
  type ChartTimeframe,
} from "@/app/(dashboard)/chart/actions";

export function useChartData(
  ticker: string,
  timeframe: ChartTimeframe,
  outputSize: "compact" | "full" = "compact",
  /** When set, trade markers are filtered to this algorithm only. */
  algorithmId: string | null = null
) {
  return useQuery({
    queryKey: ["chart-data", ticker, timeframe, outputSize, algorithmId],
    // 30s — bars rotate at the timeframe cadence; 30s is plenty fresh
    // for any TF >= 15min and avoids hammering the price provider.
    staleTime: 30_000,
    queryFn: async () => {
      const result = await getChartDataAction(ticker, timeframe, outputSize, algorithmId);
      if (!result.success) throw new Error(result.error);
      return result.data;
    },
    enabled: ticker.length > 0,
  });
}
