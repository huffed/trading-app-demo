"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  createTrade,
  updateTrade,
  deleteTrade,
  importTrades,
} from "@/app/(dashboard)/trades/actions";
import { createClient } from "@/lib/supabase/client";
import type { TradeFormValues } from "@/lib/validators/trade";
import type { Trade, TradeFilters } from "@/types/trade";

const TRADES_KEY = ["trades"];

export function useTradesList(filters: TradeFilters = {}, page = 1, perPage = 50) {
  return useQuery({
    queryKey: [...TRADES_KEY, filters, page, perPage],
    queryFn: async () => {
      const supabase = createClient();
      let query = supabase
        .from("trades")
        .select("*", { count: "exact" })
        .order("entry_date", { ascending: false });

      if (filters.status) query = query.eq("status", filters.status);
      if (filters.side) query = query.eq("side", filters.side);
      if (filters.asset_class) query = query.eq("asset_class", filters.asset_class);
      if (filters.symbol) query = query.ilike("symbol", `%${filters.symbol}%`);
      if (filters.strategy) query = query.ilike("strategy", `%${filters.strategy}%`);
      if (filters.date_from) query = query.gte("entry_date", filters.date_from);
      if (filters.date_to) query = query.lte("entry_date", filters.date_to);

      const from = (page - 1) * perPage;
      const to = from + perPage - 1;
      query = query.range(from, to);

      const { data, error, count } = await query;
      if (error) throw error;

      return {
        trades: (data ?? []) as Trade[],
        total: count ?? 0,
        page,
        perPage,
      };
    },
  });
}

export function useTrade(id: string | null) {
  return useQuery({
    queryKey: [...TRADES_KEY, id],
    enabled: !!id,
    queryFn: async () => {
      if (!id) throw new Error("Trade ID is required");
      const supabase = createClient();
      const { data, error } = await supabase.from("trades").select("*").eq("id", id).single();
      if (error) throw error;
      return data as Trade;
    },
  });
}

export function useCreateTrade() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (values: TradeFormValues) => createTrade(values),
    onSuccess: (result) => {
      if (result.success) {
        queryClient.invalidateQueries({ queryKey: TRADES_KEY });
      }
    },
  });
}

export function useUpdateTrade() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, values }: { id: string; values: Partial<TradeFormValues> }) =>
      updateTrade(id, values),
    onSuccess: (result) => {
      if (result.success) {
        queryClient.invalidateQueries({ queryKey: TRADES_KEY });
      }
    },
  });
}

export function useDeleteTrade() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteTrade(id),
    onSuccess: (result) => {
      if (result.success) {
        queryClient.invalidateQueries({ queryKey: TRADES_KEY });
      }
    },
  });
}

export function useImportTrades() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (rows: TradeFormValues[]) => importTrades(rows),
    onSuccess: (result) => {
      if (result.success) {
        queryClient.invalidateQueries({ queryKey: TRADES_KEY });
      }
    },
  });
}
