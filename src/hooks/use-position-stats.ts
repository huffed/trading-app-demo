"use client";

import { useQuery } from "@tanstack/react-query";
import { getPatternVisualization } from "@/app/(dashboard)/algorithms/pattern-viz-actions";
import { getPositionChartData } from "@/app/(dashboard)/algorithms/position-chart-actions";
import {
  getPositionEntryContext,
  getPositionEvents,
} from "@/app/(dashboard)/algorithms/position-events-actions";
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

/** Activity events tied to this position via position_id. */
export function usePositionEvents(positionId: string, enabled: boolean) {
  return useQuery({
    queryKey: ["position-events", positionId],
    enabled,
    staleTime: 30_000,
    queryFn: async () => {
      const r = await getPositionEvents(positionId);
      if (!r.success) throw new Error(r.error);
      return r.data;
    },
  });
}

/** Algorithm's entry condition list + count of conditions fired at entry. */
export function usePositionEntryContext(positionId: string, enabled: boolean) {
  return useQuery({
    queryKey: ["position-entry-context", positionId],
    enabled,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const r = await getPositionEntryContext(positionId);
      if (!r.success) throw new Error(r.error);
      return r.data;
    },
  });
}

/** Bars covering position lifetime + context window for the chart panel. */
export function usePositionChartData(positionId: string, enabled: boolean) {
  return useQuery({
    queryKey: ["position-chart-data", positionId],
    enabled,
    staleTime: 60_000,
    queryFn: async () => {
      const r = await getPositionChartData(positionId);
      if (!r.success) throw new Error(r.error);
      return r.data;
    },
  });
}

/** Pattern visualization data for a specific entry condition. */
export function usePatternVisualization(
  positionId: string,
  conditionIndex: number | null
) {
  return useQuery({
    queryKey: ["pattern-viz", positionId, conditionIndex],
    enabled: conditionIndex != null,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      if (conditionIndex == null) return null;
      const r = await getPatternVisualization(positionId, conditionIndex);
      if (!r.success) throw new Error(r.error);
      return r.data;
    },
  });
}
