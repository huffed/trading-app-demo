"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  applyCellConfigAction,
  getGeometrySweepAction,
  runGeometrySweepAction,
} from "@/app/(dashboard)/algorithms/[algoId]/validate/actions";
import type { AxisKey } from "@/app/(dashboard)/algorithms/[algoId]/validate/types";

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
    mutationFn: async (params: { algorithmId: string; xAxis: AxisKey; yAxis: AxisKey }) => {
      const r = await runGeometrySweepAction(params.algorithmId, params.xAxis, params.yAxis);
      if (!r.success) throw new Error(r.error);
      return r.data;
    },
    onSuccess: (_, params) => {
      queryClient.invalidateQueries({ queryKey: KEY(params.algorithmId) });
    },
  });
}

export function useApplyCellConfig() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: {
      algorithmId: string;
      xAxis: AxisKey;
      yAxis: AxisKey;
      x: number | boolean;
      y: number | boolean;
    }) => {
      const r = await applyCellConfigAction(
        params.algorithmId,
        params.xAxis,
        params.yAxis,
        params.x,
        params.y
      );
      if (!r.success) throw new Error(r.error);
      return r.data;
    },
    onSuccess: (_, params) => {
      queryClient.invalidateQueries({ queryKey: ["algorithms"] });
      queryClient.invalidateQueries({ queryKey: ["algorithm", params.algorithmId] });
      queryClient.invalidateQueries({ queryKey: ["backtest-trades", params.algorithmId] });
    },
  });
}
