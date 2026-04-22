"use server";

import { runBacktest } from "@/lib/market-data/backtest-engine";
import { getCachedPrices, savePricesToCache } from "@/lib/market-data/price-cache";
import { fetchDailyPrices } from "@/lib/market-data/prices";
import type { BacktestMetrics } from "@/lib/market-data/types";
import type { Algorithm, AlgorithmRules } from "@/types/algorithm";
import type { DiscoverySuggestion } from "@/types/watchlist";
import { getAuthedUser } from "./actions";
import { discoverTickers } from "./discovery-actions";
import { bulkAddWatchlistItems } from "./watchlist-actions";

type ActionResult<T = unknown> =
  | { success: true; data: T }
  | { success: false; error: string };

export interface SeedResult {
  discovered: number;
  backtested: number;
  profitable: number;
  added: DiscoverySuggestion[];
}

async function backtestSuggestion(
  rules: AlgorithmRules,
  capital: number,
  ticker: string
): Promise<BacktestMetrics | null> {
  try {
    let prices = await getCachedPrices(ticker, "compact");
    if (!prices) {
      prices = await fetchDailyPrices(ticker, "compact");
      savePricesToCache(ticker, "compact", prices).catch(() => {});
    }
    if (prices.length < 30) return null;
    return runBacktest(rules, prices, capital);
  } catch {
    return null;
  }
}

export async function seedWatchlist(
  algorithmId: string
): Promise<ActionResult<SeedResult>> {
  const { supabase, user } = await getAuthedUser();

  const { data: algo, error: algoErr } = await supabase
    .from("algorithms")
    .select("*")
    .eq("id", algorithmId)
    .eq("user_id", user.id)
    .single();

  if (algoErr || !algo) {
    return { success: false, error: "Algorithm not found" };
  }

  // 1. Discover tickers
  const discoveryResult = await discoverTickers(algorithmId);
  if (!discoveryResult.success) {
    return { success: false, error: discoveryResult.error };
  }

  const suggestions = discoveryResult.data;
  if (suggestions.length === 0) {
    return { success: true, data: { discovered: 0, backtested: 0, profitable: 0, added: [] } };
  }

  // 2. Backtest each and filter to profitable
  const rules = algo.rules as AlgorithmRules;
  const profitable: DiscoverySuggestion[] = [];

  for (const s of suggestions) {
    const metrics = await backtestSuggestion(rules, (algo as Algorithm).capital, s.ticker);
    if (metrics && metrics.total_return > 0) {
      profitable.push(s);
    }
  }

  // 3. Add profitable tickers to watchlist
  if (profitable.length > 0) {
    await bulkAddWatchlistItems(
      algorithmId,
      profitable.map((s) => ({ symbol: s.ticker, name: s.name })),
      "ai"
    );
  }

  return {
    success: true,
    data: {
      discovered: suggestions.length,
      backtested: suggestions.length,
      profitable: profitable.length,
      added: profitable,
    },
  };
}
