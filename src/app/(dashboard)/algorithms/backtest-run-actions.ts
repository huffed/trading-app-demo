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
