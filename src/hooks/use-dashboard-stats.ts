"use client";

import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { getTradeStats } from "@/lib/utils/pnl";
import type { Trade } from "@/types/trade";

const DASHBOARD_KEY = ["dashboard-stats"];

export function useDashboardStats() {
  return useQuery({
    queryKey: DASHBOARD_KEY,
    // Trades-summary card on the dashboard. Doesn't need realtime because
    // P&L deltas show up on the trades page first; 60s is a balance
    // between freshness and the cost of re-running getTradeStats.
    staleTime: 60_000,
    queryFn: async () => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("trades")
        .select(
          "id, symbol, side, quantity, entry_price, exit_price, entry_date, exit_date, status, realized_pnl, asset_class, currency"
        )
        .order("entry_date", { ascending: false });

      if (error) throw error;

      const trades = (data ?? []) as Trade[];
      const stats = getTradeStats(trades);

      return { trades, stats };
    },
  });
}
