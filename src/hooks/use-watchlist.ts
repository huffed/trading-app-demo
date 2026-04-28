"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  addWatchlistItem,
  bulkAddWatchlistItems,
  removeWatchlistItem,
  resumeWatchlistItem,
} from "@/app/(dashboard)/algorithms/watchlist-actions";
import { createClient } from "@/lib/supabase/client";
import type { WatchlistAddedBy, WatchlistItem } from "@/types/watchlist";

const WATCHLIST_KEY = ["watchlist"];

export function useWatchlist(algorithmId: string | null) {
  return useQuery({
    queryKey: [...WATCHLIST_KEY, algorithmId],
    enabled: !!algorithmId,
    queryFn: async () => {
      if (!algorithmId) throw new Error("Algorithm ID is required");
      const supabase = createClient();
      const { data, error } = await supabase
        .from("algorithm_watchlist")
        .select("*")
        .eq("algorithm_id", algorithmId)
        .order("created_at", { ascending: true });
      if (error) throw error;
      return (data ?? []) as WatchlistItem[];
    },
  });
}

export function useAddWatchlistItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      algorithmId,
      ticker,
      name,
      addedBy,
    }: {
      algorithmId: string;
      ticker: string;
      name?: string;
      addedBy?: WatchlistAddedBy;
    }) => addWatchlistItem(algorithmId, ticker, name, addedBy),
    onSuccess: (result) => {
      if (result.success) {
        queryClient.invalidateQueries({ queryKey: WATCHLIST_KEY });
      }
    },
  });
}

export function useBulkAddWatchlistItems() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      algorithmId,
      items,
      addedBy,
    }: {
      algorithmId: string;
      items: { symbol: string; name: string }[];
      addedBy: WatchlistAddedBy;
    }) => bulkAddWatchlistItems(algorithmId, items, addedBy),
    onSuccess: (result) => {
      if (result.success) {
        queryClient.invalidateQueries({ queryKey: WATCHLIST_KEY });
      }
    },
  });
}

export function useRemoveWatchlistItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => removeWatchlistItem(id),
    onSuccess: (result) => {
      if (result.success) {
        queryClient.invalidateQueries({ queryKey: WATCHLIST_KEY });
      }
    },
  });
}

export function useResumeWatchlistItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => resumeWatchlistItem(id),
    onSuccess: (result) => {
      if (result.success) {
        queryClient.invalidateQueries({ queryKey: WATCHLIST_KEY });
      }
    },
  });
}
