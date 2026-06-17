"use server";

import { fetchEconomicCalendar } from "@/lib/market-data/economic-calendar";
import { timeframeToInterval } from "@/lib/market-data/interval";
import { runPortfolioBacktest } from "@/lib/market-data/portfolio-backtest";
import { getCachedPrices, savePricesToCache } from "@/lib/market-data/price-cache";
import { fetchDailyPrices } from "@/lib/market-data/prices";
import type { BacktestTrade } from "@/lib/market-data/types";
import { getAuthedUser } from "@/lib/supabase/get-authed-user";
import { type ActionResult } from "@/lib/types/action-result";
import type { AlgorithmRules } from "@/types/algorithm";

export interface BacktestTradeRow {
  id: string;
  algorithm_id: string;
  ticker: string;
  side: "long" | "short";
  entry_date: string;
  exit_date: string;
  entry_price: number;
  exit_price: number;
  pnl: number;
  r_multiple: number | null;
  exit_reason: string | null;
  run_at: string;
}

export interface BacktestRunMeta {
  run_at: string;
  trade_count: number;
  /** First/last trade timestamps so the UI can summarise the window. */
  first_entry: string | null;
  last_exit: string | null;
}

export async function getBacktestTradesAction(
  algorithmId: string
): Promise<ActionResult<{ trades: BacktestTradeRow[]; meta: BacktestRunMeta | null }>> {
  if (!algorithmId) return { success: false, error: "missing algorithm id" };
  try {
    const { supabase, user } = await getAuthedUser();
    // backtest_trades isn't in the regenerated DB types yet (migration
    // 00043). Drop typed schema for these new-table calls until types
    // are regenerated post-apply.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sb = supabase as any;
    const { data, error } = await sb
      .from("backtest_trades")
      .select("*")
      .eq("user_id", user.id)
      .eq("algorithm_id", algorithmId)
      .order("entry_date", { ascending: false })
      .limit(2000);
    if (error) return { success: false, error: error.message };
    const trades = (data ?? []).map(toRow);
    const meta: BacktestRunMeta | null = trades.length === 0 ? null : {
      run_at: trades[0].run_at,
      trade_count: trades.length,
      first_entry: trades[trades.length - 1]?.entry_date ?? null,
      last_exit: trades[0]?.exit_date ?? null,
    };
    return { success: true, data: { trades, meta } };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : "Trade load failed" };
  }
}

interface BacktestRowFromDb {
  id: string;
  algorithm_id: string;
  ticker: string;
  side: "long" | "short";
  entry_date: string;
  exit_date: string;
  entry_price: number | string;
  exit_price: number | string;
  pnl: number | string;
  r_multiple: number | string | null;
  exit_reason: string | null;
  run_at: string;
}

function toRow(r: BacktestRowFromDb): BacktestTradeRow {
  return {
    id: r.id,
    algorithm_id: r.algorithm_id,
    ticker: r.ticker,
    side: r.side,
    entry_date: r.entry_date,
    exit_date: r.exit_date,
    entry_price: Number(r.entry_price),
    exit_price: Number(r.exit_price),
    pnl: Number(r.pnl),
    r_multiple: r.r_multiple != null ? Number(r.r_multiple) : null,
    exit_reason: r.exit_reason,
    run_at: r.run_at,
  };
}

export async function runAlgorithmBacktestAction(
  algorithmId: string
): Promise<ActionResult<{ trade_count: number; run_at: string }>> {
  if (!algorithmId) return { success: false, error: "missing algorithm id" };
  try {
    const { supabase, user } = await getAuthedUser();

    const algoRes = await supabase
      .from("algorithms")
      .select("rules, capital")
      .eq("id", algorithmId)
      .eq("user_id", user.id)
      .single();
    if (algoRes.error) return { success: false, error: algoRes.error.message };
    const rules = (algoRes.data as unknown as { rules: AlgorithmRules }).rules;
    const capital = (algoRes.data as unknown as { capital: number }).capital;

    if (rules.llm_trader?.enabled) {
      return {
        success: false,
        error:
          "LLM-trader algorithms can't be replayed from here yet — each per-bar decision is a live LLM call (~$1-5 per run). Use the harness scripts.",
      };
    }

    const wlRes = await supabase
      .from("algorithm_watchlist")
      .select("ticker")
      .eq("algorithm_id", algorithmId);
    const tickers = ((wlRes.data ?? []) as { ticker: string }[]).map((w) =>
      w.ticker.toUpperCase()
    );
    if (tickers.length === 0) {
      return { success: false, error: "Algorithm watchlist is empty" };
    }

    const interval = timeframeToInterval(rules.timeframe);
    const pricesByTicker = await loadPricesForTickers(tickers, interval);
    if (pricesByTicker.size === 0) {
      return { success: false, error: "No price history available for the watchlist tickers" };
    }

    const events = rules.news_veto?.enabled
      ? await fetchEconomicCalendarForRange(pricesByTicker)
      : [];

    const result = runPortfolioBacktest(rules, pricesByTicker, capital, events);

    const runAt = new Date().toISOString();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sb = supabase as any;
    await sb
      .from("backtest_trades")
      .delete()
      .eq("user_id", user.id)
      .eq("algorithm_id", algorithmId);

    if (result.trades.length > 0) {
      const rows = result.trades.map((t) => toInsertRow(t, algorithmId, user.id, runAt, tickers[0]));
      const ins = await sb.from("backtest_trades").insert(rows);
      if (ins.error) return { success: false, error: ins.error.message };
    }
    return { success: true, data: { trade_count: result.trades.length, run_at: runAt } };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : "Backtest run failed" };
  }
}

async function loadPricesForTickers(
  tickers: string[],
  interval: ReturnType<typeof timeframeToInterval>
): Promise<Map<string, Awaited<ReturnType<typeof fetchDailyPrices>>>> {
  const out = new Map<string, Awaited<ReturnType<typeof fetchDailyPrices>>>();
  for (const ticker of tickers) {
    let prices = await getCachedPrices(ticker, "full", interval);
    if (!prices) {
      try {
        prices = await fetchDailyPrices(ticker, "full", interval);
        savePricesToCache(ticker, "full", prices, interval).catch(() => {});
      } catch {
        continue;
      }
    }
    if (prices && prices.length >= 30) out.set(ticker, prices);
  }
  return out;
}

async function fetchEconomicCalendarForRange(
  pricesByTicker: Map<string, Awaited<ReturnType<typeof fetchDailyPrices>>>
): Promise<Awaited<ReturnType<typeof fetchEconomicCalendar>>> {
  let earliest = new Date();
  let latest = new Date(0);
  for (const prices of pricesByTicker.values()) {
    if (prices.length === 0) continue;
    const a = new Date(prices[0].date);
    const b = new Date(prices[prices.length - 1].date);
    if (a < earliest) earliest = a;
    if (b > latest) latest = b;
  }
  return fetchEconomicCalendar(earliest, latest);
}

function toInsertRow(
  t: BacktestTrade,
  algorithmId: string,
  userId: string,
  runAt: string,
  fallbackTicker: string
) {
  return {
    user_id: userId,
    algorithm_id: algorithmId,
    run_at: runAt,
    ticker: t.ticker ?? fallbackTicker,
    side: t.side,
    entry_date: t.entry_date,
    exit_date: t.exit_date,
    entry_price: t.entry_price,
    exit_price: t.exit_price,
    pnl: t.pnl,
    r_multiple: null,
    exit_reason: t.exit_reason ?? null,
  };
}
