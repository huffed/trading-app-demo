"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getBacktestTradesAction,
  runAlgorithmBacktestAction,
} from "@/app/(dashboard)/backtest/actions";

export function useAlgoTrades(algorithmId: string | null) {
  return useQuery({
    queryKey: ["backtest-trades", algorithmId],
    enabled: !!algorithmId,
    staleTime: 30_000,
    queryFn: async () => {
      if (!algorithmId) throw new Error("algorithm id required");
      const r = await getBacktestTradesAction(algorithmId);
      if (!r.success) throw new Error(r.error);
      return r.data;
    },
  });
}

export function useRunAlgorithmBacktest() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (algorithmId: string) => {
      const r = await runAlgorithmBacktestAction(algorithmId);
      if (!r.success) throw new Error(r.error);
      return r.data;
    },
    onSuccess: (_, algorithmId) => {
      queryClient.invalidateQueries({ queryKey: ["backtest-trades", algorithmId] });
    },
  });
}
