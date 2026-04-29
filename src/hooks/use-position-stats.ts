"use client";

import { useQuery } from "@tanstack/react-query";
import {
  getPositionLiveQuote,
  getPositionMaeMfe,
} from "@/app/(dashboard)/algorithms/position-stats-actions";

/**
 * Live bid/ask/spread for an open position. 15s stale time — quotes
 * move but not so fast that every keystroke needs a fresh fetch.
 * `enabled` lets the caller defer the fetch until the position card
 * is expanded (saves API cost when the row is collapsed).
 */
export function usePositionLiveQuote(positionId: string, enabled: boolean) {
  return useQuery({
    queryKey: ["position-quote", positionId],
    enabled,
    staleTime: 15_000,
    refetchInterval: enabled ? 15_000 : false,
    queryFn: async () => {
      const r = await getPositionLiveQuote(positionId);
      if (!r.success) throw new Error(r.error);
      return r.data;
    },
  });
}

/**
 * MAE/MFE computed from cached price bars over the position's lifetime.
 * Doesn't change as fast as live quote; 60s stale is fine.
 */
export function usePositionMaeMfe(positionId: string, enabled: boolean) {
  return useQuery({
    queryKey: ["position-mae-mfe", positionId],
    enabled,
    staleTime: 60_000,
    queryFn: async () => {
      const r = await getPositionMaeMfe(positionId);
      if (!r.success) throw new Error(r.error);
      return r.data;
    },
  });
}
