"use server";

import type { runPortfolioBacktest as runPortfolioBacktestEngine } from "@/lib/market-data/portfolio-backtest";
import { rulesFromRow } from "@/lib/supabase/row-mappers";
import { createClient } from "@/lib/supabase/server";
import { type ActionResult } from "@/types/action-result";
import type { AlgorithmRules } from "@/types/algorithm";


type PortfolioBacktestResult = ReturnType<typeof runPortfolioBacktestEngine>;

async function fetchPricesForPortfolio(
  tickers: string[],
  outputSize: "compact" | "full",
  interval: import("@/lib/market-data/interval").BarInterval
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

export type BacktestWindow = "1m" | "3m" | "6m" | "1y" | "all";

const WINDOW_MS: Record<Exclude<BacktestWindow, "all">, number> = {
  "1m": 30 * 24 * 60 * 60 * 1000,
  "3m": 90 * 24 * 60 * 60 * 1000,
  "6m": 180 * 24 * 60 * 60 * 1000,
  "1y": 365 * 24 * 60 * 60 * 1000,
};

/**
 * Slice a ticker's bar series to the trailing window measured from its
 * LAST bar (not "now") — keeps the cutoff stable across runs even when
 * the cached data is a few hours/days old. Returns the original series
 * unchanged when window is "all" or when data is shorter than the window.
 */
function slicePricesToWindow<T extends { date: string }>(
  prices: T[],
  window: BacktestWindow
): T[] {
  if (window === "all" || prices.length === 0) return prices;
  const ms = WINDOW_MS[window];
  const lastDate = new Date(prices[prices.length - 1].date).getTime();
  const cutoff = lastDate - ms;
  const sliced = prices.filter((p) => new Date(p.date).getTime() >= cutoff);
  return sliced.length >= 30 ? sliced : prices;
}

type PortfolioPrices = Awaited<ReturnType<typeof fetchPricesForPortfolio>>;

/**
 * Run the algorithm across every ticker in its watchlist simultaneously
 * with a single shared capital pool. Reveals the combined-portfolio return
 * the user would actually experience in paper trading, vs. the per-pair
 * numbers shown by the single-ticker backtest.
 *
 * `window` slices the historical data to that trailing range — lets the
 * caller compare recent performance ("1m") to older performance ("1y") so
 * regime drift is visible. Defaults to "all" for backwards compatibility.
 */
// B.1.24 (Stage 3, 2026-06-19 EVE): server-action wrapper around the engine.
// Gates intentionally OFF (only `rules + prices + capital + events` passed).
// The Algorithm-detail UI shows naked strategy performance per-period; gated
// verdicts are validate-algo's exclusive responsibility. See caller-policy
// in `portfolio-backtest.ts` + CLAUDE.md Phase B.1.9.
export async function runPortfolioBacktest(
  algorithmId: string,
  outputSize: "compact" | "full",
  window: BacktestWindow = "all"
): Promise<ActionResult<PortfolioBacktestResult>> {
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

  const rules = rulesFromRow(algo.rules);
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
    // Apply the time-window slice per ticker before handing to the engine.
    const sliced: PortfolioPrices = new Map();
    for (const [ticker, prices] of pricesByTicker) {
      sliced.set(ticker, slicePricesToWindow(prices, window));
    }
    const events = await fetchPortfolioCalendar(rules, sliced);
    return { success: true, data: runEngine(rules, sliced, algo.capital, { events }) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Portfolio backtest failed";
    return { success: false, error: msg };
  }
}
