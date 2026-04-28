"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  deleteAlgorithm,
  generateAlgorithm,
  updateAlgorithm,
  updateAlgorithmStatus,
} from "@/app/(dashboard)/algorithms/actions";
import {
  runAiBacktest,
  runHistoricalBacktest,
  runPortfolioBacktest,
} from "@/app/(dashboard)/algorithms/backtest-run-actions";
import { createClient } from "@/lib/supabase/client";
import type {
  AlgorithmFormValues,
  AlgorithmUpdate,
} from "@/lib/validators/algorithm";
import type { Algorithm, AlgorithmStatus } from "@/types/algorithm";

const ALGORITHMS_KEY = ["algorithms"];

export function useAlgorithmsList() {
  return useQuery({
    queryKey: ALGORITHMS_KEY,
    queryFn: async () => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("algorithms")
        .select("*")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as Algorithm[];
    },
  });
}

export function useAlgorithm(id: string | null) {
  return useQuery({
    queryKey: [...ALGORITHMS_KEY, id],
    enabled: !!id,
    queryFn: async () => {
      if (!id) throw new Error("Algorithm ID is required");
      const supabase = createClient();
      const { data, error } = await supabase.from("algorithms").select("*").eq("id", id).single();
      if (error) throw error;
      return data as Algorithm;
    },
  });
}

export function useGenerateAlgorithm() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (values: AlgorithmFormValues) => generateAlgorithm(values),
    onSuccess: (result) => {
      if (result.success) {
        queryClient.invalidateQueries({ queryKey: ALGORITHMS_KEY });
      }
    },
  });
}

export function useDeleteAlgorithm() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteAlgorithm(id),
    onSuccess: (result) => {
      if (result.success) {
        queryClient.invalidateQueries({ queryKey: ALGORITHMS_KEY });
      }
    },
  });
}

export function useUpdateAlgorithm() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, updates }: { id: string; updates: AlgorithmUpdate }) =>
      updateAlgorithm(id, updates),
    onSuccess: (result) => {
      if (result.success) {
        queryClient.invalidateQueries({ queryKey: ALGORITHMS_KEY });
      }
    },
  });
}

export function useUpdateAlgorithmStatus() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: AlgorithmStatus }) =>
      updateAlgorithmStatus(id, status),
    onSuccess: (result) => {
      if (result.success) {
        queryClient.invalidateQueries({ queryKey: ALGORITHMS_KEY });
      }
    },
  });
}

export function useRunAiBacktest() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (algorithmId: string) => runAiBacktest(algorithmId),
    onSuccess: (result) => {
      if (result.success) {
        queryClient.invalidateQueries({ queryKey: ALGORITHMS_KEY });
      }
    },
  });
}

export function useRunHistoricalBacktest() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      symbol,
      period,
    }: {
      id: string;
      symbol: string;
      period: "compact" | "full";
    }) => runHistoricalBacktest(id, symbol, period),
    onSuccess: (result) => {
      if (result.success) {
        queryClient.invalidateQueries({ queryKey: ALGORITHMS_KEY });
      }
    },
  });
}

export function useRunPortfolioBacktest() {
  return useMutation({
    mutationFn: ({
      id,
      period,
      window,
    }: {
      id: string;
      period: "compact" | "full";
      window?: "1m" | "3m" | "6m" | "1y" | "all";
    }) => runPortfolioBacktest(id, period, window ?? "all"),
  });
}
