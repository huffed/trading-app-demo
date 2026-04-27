"use server";

import { AI_MODEL, getAIClient } from "@/lib/ai/client";
import { buildAiBacktestPrompt } from "@/lib/ai/prompts/backtest";
import { createClient } from "@/lib/supabase/server";
import type { Algorithm, AlgorithmRules } from "@/types/algorithm";
import type { Trade } from "@/types/trade";

type ActionResult<T = unknown> = { success: true; data: T } | { success: false; error: string };

export async function runAiBacktest(algorithmId: string): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { success: false, error: "Not authenticated" };

  const { data: algo, error: algoErr } = await supabase
    .from("algorithms")
    .select("*")
    .eq("id", algorithmId)
    .eq("user_id", user.id)
    .single();
  if (algoErr || !algo) return { success: false, error: "Algorithm not found" };

  const { data: trades } = await supabase.from("trades").select("*");

  try {
    const client = getAIClient();
    const { system, userMessage } = buildAiBacktestPrompt(
      algo as Algorithm,
      (trades ?? []) as Trade[]
    );

    const res = await client.chat.completions.create({
      model: AI_MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: userMessage },
      ],
      max_tokens: 1024,
    });

    const analysisText = res.choices[0]?.message?.content;
    if (!analysisText) return { success: false, error: "No response from AI" };

    await supabase.from("algorithms").update({ ai_analysis: analysisText }).eq("id", algorithmId);

    return { success: true, data: { ai_analysis: analysisText } };
  } catch {
    return {
      success: false,
      error: "AI is temporarily unavailable. Please try again in a moment.",
    };
  }
}

export async function runHistoricalBacktest(
  algorithmId: string,
  symbol: string,
  outputSize: "compact" | "full"
): Promise<ActionResult> {
  const { fetchDailyPrices } = await import("@/lib/market-data/prices");
  const { getCachedPrices, savePricesToCache } = await import("@/lib/market-data/price-cache");
  const { runBacktest } = await import("@/lib/market-data/backtest-engine");

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { success: false, error: "Not authenticated" };

  const { data: algo, error: algoErr } = await supabase
    .from("algorithms")
    .select("*")
    .eq("id", algorithmId)
    .eq("user_id", user.id)
    .single();
  if (algoErr || !algo) return { success: false, error: "Algorithm not found" };

  const rules = algo.rules as AlgorithmRules;
  if (!rules.entry_conditions || rules.entry_conditions.length === 0) {
    return { success: false, error: "Algorithm has no trading rules. Try regenerating it." };
  }

  const { timeframeToInterval } = await import("@/lib/market-data/interval");
  const { fetchEconomicCalendar } = await import("@/lib/market-data/economic-calendar");
  const interval = timeframeToInterval(rules.timeframe);

  try {
    let prices = await getCachedPrices(symbol, outputSize, interval);
    if (!prices) {
      prices = await fetchDailyPrices(symbol, outputSize, interval);
      savePricesToCache(symbol, outputSize, prices, interval).catch((e) =>
        console.warn(`[price-cache] Failed to cache ${symbol}:`, e instanceof Error ? e.message : e)
      );
    }
    if (prices.length < 30) {
      return { success: false, error: "Not enough price data for backtesting" };
    }

    // Fetch the economic calendar covering the price range so the news veto
    // (if enabled on the algorithm) can block entries around major releases.
    let events: Awaited<ReturnType<typeof fetchEconomicCalendar>> = [];
    if (rules.news_veto?.enabled) {
      const from = new Date(prices[0].date);
      const to = new Date(prices[prices.length - 1].date);
      events = await fetchEconomicCalendar(from, to);
    }

    const results = runBacktest(rules, prices, algo.capital, { symbol, events });

    // Strip prices from DB save (too large for JSONB), keep trades for display
    const { prices: _prices, ...storable } = results;
    await supabase.from("algorithms").update({ backtest_results: storable }).eq("id", algorithmId);

    return { success: true, data: results };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Backtest failed";
    return { success: false, error: msg };
  }
}

async function fetchPricesForPortfolio(
  tickers: string[],
  outputSize: "compact" | "full",
  interval: "1day" | "4h" | "1h"
): Promise<Map<string, Awaited<ReturnType<typeof import("@/lib/market-data/prices").fetchDailyPrices>>>> {
  const { fetchDailyPrices } = await import("@/lib/market-data/prices");
  const { getCachedPrices, savePricesToCache } = await import("@/lib/market-data/price-cache");
  const out = new Map<string, Awaited<ReturnType<typeof fetchDailyPrices>>>();
  for (const ticker of tickers) {
    let prices = await getCachedPrices(ticker, outputSize, interval);
    if (!prices) {
      try {
        prices = await fetchDailyPrices(ticker, outputSize, interval);
        savePricesToCache(ticker, outputSize, prices, interval).catch(() => {});
      } catch (e) {
        console.warn(
          `[portfolio-backtest] price fetch failed for ${ticker}:`,
          e instanceof Error ? e.message : e
        );
        continue;
      }
    }
    if (prices && prices.length >= 30) out.set(ticker, prices);
  }
  return out;
}

async function fetchPortfolioCalendar(
  rules: AlgorithmRules,
  pricesByTicker: Map<string, Awaited<ReturnType<typeof import("@/lib/market-data/prices").fetchDailyPrices>>>
) {
  const { fetchEconomicCalendar } = await import("@/lib/market-data/economic-calendar");
  if (!rules.news_veto?.enabled) return [];
  let earliest = new Date();
  let latest = new Date(0);
  for (const prices of pricesByTicker.values()) {
    const a = new Date(prices[0].date);
    const b = new Date(prices[prices.length - 1].date);
    if (a < earliest) earliest = a;
    if (b > latest) latest = b;
  }
  return fetchEconomicCalendar(earliest, latest);
}

/**
 * Run the algorithm across every ticker in its watchlist simultaneously
 * with a single shared capital pool. Reveals the combined-portfolio return
 * the user would actually experience in paper trading, vs. the per-pair
 * numbers shown by the single-ticker backtest.
 */
export async function runPortfolioBacktest(
  algorithmId: string,
  outputSize: "compact" | "full"
): Promise<ActionResult> {
  const { runPortfolioBacktest: runEngine } = await import(
    "@/lib/market-data/portfolio-backtest"
  );
  const { timeframeToInterval } = await import("@/lib/market-data/interval");

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { success: false, error: "Not authenticated" };

  const { data: algo, error: algoErr } = await supabase
    .from("algorithms")
    .select("*")
    .eq("id", algorithmId)
    .eq("user_id", user.id)
    .single();
  if (algoErr || !algo) return { success: false, error: "Algorithm not found" };

  const { data: watchlist } = await supabase
    .from("algorithm_watchlist")
    .select("ticker")
    .eq("algorithm_id", algorithmId);
  const tickers = (watchlist ?? []).map((w) => (w.ticker as string).toUpperCase());
  if (tickers.length === 0) {
    return {
      success: false,
      error: "Watchlist is empty. Add tickers or run Discover & Screen first.",
    };
  }

  const rules = algo.rules as AlgorithmRules;
  if (!rules.entry_conditions || rules.entry_conditions.length === 0) {
    return { success: false, error: "Algorithm has no trading rules. Try regenerating it." };
  }

  try {
    const pricesByTicker = await fetchPricesForPortfolio(
      tickers,
      outputSize,
      timeframeToInterval(rules.timeframe)
    );
    if (pricesByTicker.size === 0) {
      return {
        success: false,
        error: "No watchlist ticker had enough price data for backtesting.",
      };
    }
    const events = await fetchPortfolioCalendar(rules, pricesByTicker);
    return { success: true, data: runEngine(rules, pricesByTicker, algo.capital, events) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Portfolio backtest failed";
    return { success: false, error: msg };
  }
}
