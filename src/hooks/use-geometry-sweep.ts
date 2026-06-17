"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  applyGeometryConfigAction,
  getGeometrySweepAction,
  runGeometrySweepAction,
} from "@/app/(dashboard)/algorithms/[algoId]/validate/actions";

const KEY = (id: string) => ["geometry-sweep", id];

export function useGeometrySweep(algorithmId: string | null) {
  return useQuery({
    queryKey: KEY(algorithmId ?? ""),
    enabled: !!algorithmId,
    staleTime: 60_000,
    queryFn: async () => {
      if (!algorithmId) throw new Error("algorithm id required");
      const r = await getGeometrySweepAction(algorithmId);
      if (!r.success) throw new Error(r.error);
      return r.data;
    },
  });
}

export function useRunGeometrySweep() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (algorithmId: string) => {
      const r = await runGeometrySweepAction(algorithmId);
      if (!r.success) throw new Error(r.error);
      return r.data;
    },
    onSuccess: (_, algorithmId) => {
      queryClient.invalidateQueries({ queryKey: KEY(algorithmId) });
    },
  });
}

export function useApplyGeometryConfig() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: { algorithmId: string; rr: number; lookback: number }) => {
      const r = await applyGeometryConfigAction(params.algorithmId, params.rr, params.lookback);
      if (!r.success) throw new Error(r.error);
      return r.data;
    },
    onSuccess: (_, params) => {
      queryClient.invalidateQueries({ queryKey: ["algorithms"] });
      queryClient.invalidateQueries({ queryKey: ["algorithm", params.algorithmId] });
      // Also invalidate backtest_trades so /backtest reflects the new geometry.
      queryClient.invalidateQueries({ queryKey: ["backtest-trades", params.algorithmId] });
    },
  });
}
