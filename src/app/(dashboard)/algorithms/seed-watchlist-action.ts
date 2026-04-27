"use server";

import { AI_MODEL, getAIClient } from "@/lib/ai/client";
import { buildAnalysisPrompt, type TickerBacktestSummary } from "@/lib/ai/prompts/discovery";
import { runBacktest } from "@/lib/market-data/backtest-engine";
import { getCachedPrices, savePricesToCache } from "@/lib/market-data/price-cache";
import { fetchDailyPrices } from "@/lib/market-data/prices";
import type { BacktestMetrics } from "@/lib/market-data/types";
import type { Algorithm, AlgorithmRules } from "@/types/algorithm";
import { getAuthedUser } from "./actions";
import { discoverTickers } from "./discovery-actions";
import { bulkAddWatchlistItems } from "./watchlist-actions";

type ActionResult<T = unknown> = { success: true; data: T } | { success: false; error: string };

export interface ScreenedTicker {
  ticker: string;
  name: string;
  sector: string;
  metrics: BacktestMetrics | null;
  /** Total return as a percent of starting capital (signed). */
  return_pct: number;
  analysis: string;
  profitable: boolean;
}

export interface ScreenResult {
  tickers: ScreenedTicker[];
  added: number;
}

async function backtestOne(
  rules: AlgorithmRules,
  capital: number,
  ticker: string
): Promise<BacktestMetrics | null> {
  const { timeframeToInterval, recommendedOutputSize, minBarsFor } = await import(
    "@/lib/market-data/interval"
  );
  const { fetchEconomicCalendar } = await import("@/lib/market-data/economic-calendar");
  const interval = timeframeToInterval(rules.timeframe);
  const outputSize = recommendedOutputSize(interval);
  const minBars = minBarsFor(interval);

  try {
    let prices = await getCachedPrices(ticker, outputSize, interval);
    if (!prices) {
      prices = await fetchDailyPrices(ticker, outputSize, interval);
      savePricesToCache(ticker, outputSize, prices, interval).catch((e) =>
        console.warn(`[price-cache] Failed to cache ${ticker}:`, e instanceof Error ? e.message : e)
      );
    }
    if (prices.length < minBars) return null;

    let events: Awaited<ReturnType<typeof fetchEconomicCalendar>> = [];
    if (rules.news_veto?.enabled) {
      const from = new Date(prices[0].date);
      const to = new Date(prices[prices.length - 1].date);
      events = await fetchEconomicCalendar(from, to);
    }

    return runBacktest(rules, prices, capital, { symbol: ticker, events });
  } catch {
    return null;
  }
}

async function generateAnalyses(
  algo: Algorithm,
  summaries: TickerBacktestSummary[]
): Promise<Record<string, string>> {
  try {
    const client = getAIClient();
    const { system, userMessage } = buildAnalysisPrompt(algo, summaries);
    const res = await client.chat.completions.create({
      model: AI_MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: userMessage },
      ],
      response_format: { type: "json_object" },
      max_tokens: 2048,
    });
    const text = res.choices[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(text) as { analyses?: { ticker: string; analysis: string }[] };
    const map: Record<string, string> = {};
    for (const a of parsed.analyses ?? []) {
      map[a.ticker] = a.analysis;
    }
    return map;
  } catch {
    return {};
  }
}

export async function seedWatchlist(algorithmId: string): Promise<ActionResult<ScreenResult>> {
  const { supabase, user } = await getAuthedUser();

  const { data: algo, error: algoErr } = await supabase
    .from("algorithms")
    .select("*")
    .eq("id", algorithmId)
    .eq("user_id", user.id)
    .single();
  if (algoErr || !algo) return { success: false, error: "Algorithm not found" };

  const discoveryResult = await discoverTickers(algorithmId);
  if (!discoveryResult.success) return { success: false, error: discoveryResult.error };
  const suggestions = discoveryResult.data;
  if (suggestions.length === 0) return { success: true, data: { tickers: [], added: 0 } };

  // Backtest each ticker
  const rules = (algo as Algorithm).rules;
  const capital = (algo as Algorithm).capital;
  const metricsMap = new Map<string, BacktestMetrics | null>();
  for (const s of suggestions) {
    metricsMap.set(s.ticker, await backtestOne(rules, capital, s.ticker));
  }

  function pct(m: BacktestMetrics | null | undefined): number {
    if (!m || !capital) return 0;
    return (m.total_return / capital) * 100;
  }

  // Build summaries for AI analysis
  const summaries: TickerBacktestSummary[] = suggestions.map((s) => {
    const m = metricsMap.get(s.ticker);
    return {
      ticker: s.ticker,
      name: s.name,
      totalReturn: pct(m),
      winRate: m?.win_rate ?? 0,
      totalTrades: m?.total_trades ?? 0,
      profitable: pct(m) > 0,
      failed: !m,
    };
  });

  // Generate AI analysis per ticker
  const analyses = await generateAnalyses(algo as Algorithm, summaries);

  // Build results
  const screened: ScreenedTicker[] = suggestions.map((s) => {
    const m = metricsMap.get(s.ticker) ?? null;
    const returnPct = pct(m);
    return {
      ticker: s.ticker,
      name: s.name,
      sector: s.sector,
      metrics: m,
      return_pct: Number(returnPct.toFixed(2)),
      analysis: analyses[s.ticker] ?? s.reasoning,
      profitable: returnPct > 0,
    };
  });

  // Sort: profitable first (by return desc), then unprofitable (by return desc)
  screened.sort((a, b) => {
    if (a.profitable !== b.profitable) return a.profitable ? -1 : 1;
    return b.return_pct - a.return_pct;
  });

  // Add profitable to watchlist
  const profitable = screened.filter((t) => t.profitable);
  if (profitable.length > 0) {
    await bulkAddWatchlistItems(
      algorithmId,
      profitable.map((t) => ({ symbol: t.ticker, name: t.name })),
      "ai"
    );
  }

  return { success: true, data: { tickers: screened, added: profitable.length } };
}
