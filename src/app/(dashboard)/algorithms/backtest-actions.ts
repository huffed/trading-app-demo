"use server";

import { runBacktest } from "@/lib/market-data/backtest-engine";
import { getCachedPrices, savePricesToCache } from "@/lib/market-data/price-cache";
import { fetchDailyPrices } from "@/lib/market-data/prices";
import type { BacktestMetrics } from "@/lib/market-data/types";
import type { AlgorithmRules } from "@/types/algorithm";
import { getAuthedUser } from "./actions";

type ActionResult<T = unknown> = { success: true; data: T } | { success: false; error: string };

export async function backtestTicker(
  algorithmId: string,
  ticker: string,
  outputSize: "compact" | "full" = "compact"
): Promise<ActionResult<BacktestMetrics>> {
  const { supabase, user } = await getAuthedUser();

  const { data: algo, error: algoErr } = await supabase
    .from("algorithms")
    .select("rules, capital")
    .eq("id", algorithmId)
    .eq("user_id", user.id)
    .single();

  if (algoErr || !algo) {
    return { success: false, error: "Algorithm not found" };
  }

  const rules = algo.rules as AlgorithmRules;
  if (!rules.entry_conditions || rules.entry_conditions.length === 0) {
    return { success: false, error: "Algorithm has no trading rules" };
  }

  try {
    let prices = await getCachedPrices(ticker, outputSize);
    if (!prices) {
      prices = await fetchDailyPrices(ticker, outputSize);
      savePricesToCache(ticker, outputSize, prices).catch((e) =>
        console.warn(`[price-cache] Failed to cache ${ticker}:`, e instanceof Error ? e.message : e)
      );
    }
    if (prices.length < 30) {
      return { success: false, error: "Not enough price data" };
    }

    const results = runBacktest(rules, prices, algo.capital);

    // Persist summary metrics on the watchlist row (strip prices to keep JSONB small)
    const { prices: _p, ...storable } = results;
    supabase
      .from("algorithm_watchlist")
      .update({ backtest_metrics: storable })
      .eq("algorithm_id", algorithmId)
      .eq("ticker", ticker.toUpperCase())
      .then(() => {});

    return { success: true, data: results };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Backtest failed";
    return { success: false, error: msg };
  }
}
