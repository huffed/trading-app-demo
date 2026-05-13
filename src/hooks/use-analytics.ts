"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import {
  computeByDayOfWeek,
  computeBySymbol,
  computeDistribution,
  computeDrawdownSeries,
  computeEquityCurve,
  computeMetrics,
  computeMonthlyReturns,
  normalizePaperPositions,
} from "@/lib/utils/analytics";
import type { PaperPosition } from "@/types/position";
import type { Trade } from "@/types/trade";
import type { TradingProfile } from "@/types/trading-profile";

export type DataSource = "all" | "manual" | "paper";

export function useAnalytics() {
  const [source, setSource] = useState<DataSource>("all");

  const { data, isLoading } = useQuery({
    queryKey: ["analytics"],
    // Closed trades + closed paper positions — heavier query, but the
    // analytics page is not realtime. 60s avoids re-running the whole
    // computation on incidental focus changes.
    staleTime: 60_000,
    queryFn: async () => {
      const supabase = createClient();
      const [tradesRes, positionsRes, profileRes] = await Promise.all([
        supabase
          .from("trades")
          .select("*")
          .eq("status", "closed")
          .order("exit_date", { ascending: true }),
        supabase
          .from("paper_positions")
          .select("*")
          .eq("status", "closed")
          .order("closed_at", { ascending: true }),
        supabase.from("profiles").select("trading_profile").maybeSingle(),
      ]);

      const profile = profileRes.data?.trading_profile as TradingProfile | null;
      return {
        trades: (tradesRes.data ?? []) as Trade[],
        positions: (positionsRes.data ?? []) as PaperPosition[],
        startingCapital: profile?.answers?.capital ?? null,
      };
    },
  });

  const trades = useMemo(() => {
    if (!data) {
      return [];
    }
    const manual = data.trades;
    const paper = normalizePaperPositions(data.positions);
    switch (source) {
      case "manual":
        return manual;
      case "paper":
        return paper;
      default:
        return [...manual, ...paper];
    }
  }, [data, source]);

  const startingCapital = data?.startingCapital ?? null;
  const metrics = useMemo(
    () => computeMetrics(trades, startingCapital),
    [trades, startingCapital]
  );
  const equityCurve = useMemo(() => computeEquityCurve(trades), [trades]);
  const drawdownSeries = useMemo(
    () => computeDrawdownSeries(trades, startingCapital),
    [trades, startingCapital]
  );
  const distribution = useMemo(() => computeDistribution(trades), [trades]);
  const monthlyReturns = useMemo(() => computeMonthlyReturns(trades), [trades]);
  const symbolPerformance = useMemo(() => computeBySymbol(trades), [trades]);
  const dayOfWeekPerformance = useMemo(() => computeByDayOfWeek(trades), [trades]);

  return {
    source,
    setSource,
    isLoading,
    metrics,
    equityCurve,
    drawdownSeries,
    distribution,
    monthlyReturns,
    symbolPerformance,
    dayOfWeekPerformance,
  };
}
