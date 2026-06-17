"use client";

import { useQuery } from "@tanstack/react-query";
import { getAlgorithmTradesAction } from "@/app/(dashboard)/backtest/actions";

export function useAlgoTrades(algorithmId: string | null) {
  return useQuery({
    queryKey: ["algo-trades", algorithmId],
    enabled: !!algorithmId,
    staleTime: 30_000,
    queryFn: async () => {
      if (!algorithmId) throw new Error("algorithm id required");
      const r = await getAlgorithmTradesAction(algorithmId);
      if (!r.success) throw new Error(r.error);
      return r.data;
    },
  });
}
