"use client";

import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { getTradeStats } from "@/lib/utils/pnl";
import type { Trade } from "@/types/trade";

const DASHBOARD_KEY = ["dashboard-stats"];

export function useDashboardStats() {
  return useQuery({
    queryKey: DASHBOARD_KEY,
    staleTime: 60_000,
    queryFn: async () => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("trades")
        .select("*")
        .order("entry_date", { ascending: false });

      if (error) throw error;

      const trades = (data ?? []) as Trade[];
      const stats = getTradeStats(trades);

      return { trades, stats };
    },
  });
}
