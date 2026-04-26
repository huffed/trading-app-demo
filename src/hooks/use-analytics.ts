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

export type DataSource = "all" | "manual" | "paper";

export function useAnalytics() {
  const [source, setSource] = useState<DataSource>("all");

  const { data, isLoading } = useQuery({
    queryKey: ["analytics"],
    staleTime: 60_000,
    queryFn: async () => {
      const supabase = createClient();
      const [tradesRes, positionsRes] = await Promise.all([
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
      ]);

      return {
        trades: (tradesRes.data ?? []) as Trade[],
        positions: (positionsRes.data ?? []) as PaperPosition[],
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

  const metrics = useMemo(() => computeMetrics(trades), [trades]);
  const equityCurve = useMemo(() => computeEquityCurve(trades), [trades]);
  const drawdownSeries = useMemo(() => computeDrawdownSeries(trades), [trades]);
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
