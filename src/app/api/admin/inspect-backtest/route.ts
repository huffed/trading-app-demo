/**
 * Admin endpoint: run a portfolio backtest and return the full trade list
 * + per-pair summary so the trades can be analysed without going through
 * the UI. Bearer-auth guarded by the same CRON_SECRET as the cron route.
 *
 * Usage:
 *   curl -H "Authorization: Bearer $CRON_SECRET" \
 *     "http://localhost:3000/api/admin/inspect-backtest?id=<algo>&window=3m"
 */
import { NextResponse } from "next/server";
import { verifyAdminAuth } from "@/lib/api/admin-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(request: Request) {
  const authError = verifyAdminAuth(request);
  if (authError) return authError;

  const url = new URL(request.url);
  const algoId = url.searchParams.get("id");
  const window = (url.searchParams.get("window") ?? "all") as
    | "1m"
    | "3m"
    | "6m"
    | "1y"
    | "all";
  if (!algoId) {
    return NextResponse.json({ error: "missing ?id=<algorithm_id>" }, { status: 400 });
  }

  // We bypass the user-scoped server action and call the engine directly,
  // since this is an admin endpoint with its own auth.
  //
  // B.1.24 (Stage 3, 2026-06-19 EVE): diagnostic caller — gates intentionally
  // OFF. Inspect-backtest dumps per-trade detail for ad-hoc forensics; gates
  // would distort which trades fire. See caller-policy in
  // `portfolio-backtest.ts` + CLAUDE.md Phase B.1.9.
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const { runPortfolioBacktest: runEngine } = await import(
    "@/lib/market-data/portfolio-backtest"
  );
  const { timeframeToInterval } = await import("@/lib/market-data/interval");
  const { fetchDailyPrices } = await import("@/lib/market-data/prices");
  const { getCachedPrices, savePricesToCache } = await import("@/lib/market-data/price-cache");
  const { fetchEconomicCalendar } = await import("@/lib/market-data/economic-calendar");

  const supabase = createAdminClient();
  const { rulesFromRow } = await import("@/lib/supabase/row-mappers");
  const algoRes = await supabase
    .from("algorithms")
    .select("rules, capital, user_id")
    .eq("id", algoId)
    .single();
  if (algoRes.error || !algoRes.data) {
    return NextResponse.json({ error: "algorithm not found" }, { status: 404 });
  }
  // CB.H3 (2026-06-20): canonical Json→AlgorithmRules bridge.
  const algo = {
    rules: rulesFromRow(algoRes.data.rules),
    capital: algoRes.data.capital,
    user_id: algoRes.data.user_id,
  };

  const watchlistRes = await supabase
    .from("algorithm_watchlist")
    .select("ticker")
    .eq("algorithm_id", algoId);
  const tickers = ((watchlistRes.data ?? []) as { ticker: string }[]).map((w) =>
    w.ticker.toUpperCase()
  );
  if (tickers.length === 0) {
    return NextResponse.json({ error: "watchlist empty" }, { status: 400 });
  }

  const interval = timeframeToInterval(algo.rules.timeframe);
  const pricesByTicker = new Map<
    string,
    Awaited<ReturnType<typeof fetchDailyPrices>>
  >();
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
    if (prices && prices.length >= 30) pricesByTicker.set(ticker, prices);
  }

  // Slice to window. Same logic as runPortfolioBacktest but inlined since
  // we're calling the engine directly.
  const WINDOW_MS: Record<string, number> = {
    "1m": 30 * 24 * 60 * 60 * 1000,
    "3m": 90 * 24 * 60 * 60 * 1000,
    "6m": 180 * 24 * 60 * 60 * 1000,
    "1y": 365 * 24 * 60 * 60 * 1000,
  };
  const sliced = new Map<string, Awaited<ReturnType<typeof fetchDailyPrices>>>();
  for (const [ticker, prices] of pricesByTicker) {
    if (window === "all" || prices.length === 0) {
      sliced.set(ticker, prices);
      continue;
    }
    const ms = WINDOW_MS[window];
    const lastDate = new Date(prices[prices.length - 1].date).getTime();
    const cutoff = lastDate - ms;
    const sub = prices.filter((p) => new Date(p.date).getTime() >= cutoff);
    sliced.set(ticker, sub.length >= 30 ? sub : prices);
  }

  let events: Awaited<ReturnType<typeof fetchEconomicCalendar>> = [];
  if (algo.rules.news_veto?.enabled) {
    let earliest = new Date();
    let latest = new Date(0);
    for (const prices of sliced.values()) {
      const a = new Date(prices[0].date);
      const b = new Date(prices[prices.length - 1].date);
      if (a < earliest) earliest = a;
      if (b > latest) latest = b;
    }
    events = await fetchEconomicCalendar(earliest, latest);
  }

  const result = runEngine(algo.rules, sliced, algo.capital, { events });
  return NextResponse.json({
    window,
    total_trades: result.total_trades,
    win_rate: result.win_rate,
    total_return: result.total_return,
    max_drawdown: result.max_drawdown,
    per_ticker: result.per_ticker,
    trades: result.trades.map((t) => ({
      ticker: t.ticker,
      entry: t.entry_date,
      exit: t.exit_date,
      side: t.side,
      entry_price: t.entry_price,
      exit_price: t.exit_price,
      pnl: t.pnl,
    })),
  });
}
