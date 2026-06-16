"use client";

import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { strategiesFromRows } from "@/lib/supabase/row-mappers";

const STRATEGIES_KEY = ["strategies"];

/**
 * Fetch all strategy umbrellas for the current user. Strategies group
 * algorithm instances (e.g. one FVG-DailyBias strategy with 4 instances
 * for XAU/USD, EUR/USD, GBP/USD, USD/JPY). Migration 00042; seed PR #266.
 *
 * Algorithms still reference their strategy via algorithms.strategy_id.
 * Use this hook + useAlgorithmsList together to render grouped views.
 */
export function useStrategiesList() {
  return useQuery({
    queryKey: STRATEGIES_KEY,
    queryFn: async () => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("strategies")
        .select("*")
        .order("name", { ascending: true });
      if (error) throw error;
      return strategiesFromRows(data ?? []);
    },
  });
}
