/**
 * Admin endpoint: run a portfolio backtest, then enrich each trade with
 * entry-time market features (distance from MA, ATR, RSI, distance from
 * recent extreme). Bucket by hold-time and compare quick-stops vs survivors
 * to identify what distinguishes losing trades at entry.
 *
 * Usage:
 *   curl -H "Authorization: Bearer $CRON_SECRET" \
 *     "http://localhost:3000/api/admin/loser-analysis?id=<algo>&window=1y"
 */
import { NextResponse } from "next/server";
import { sma, rsi } from "@/lib/market-data/indicators";
import { resampleToDaily } from "@/lib/market-data/resample";
import type { PriceBar, BacktestTrade } from "@/lib/market-data/types";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

function atr(bars: PriceBar[], period = 20): (number | null)[] {
  const tr: number[] = [];
  for (let i = 0; i < bars.length; i++) {
    if (i === 0) {
      tr.push(bars[0].high - bars[0].low);
      continue;
    }
    const prevClose = bars[i - 1].close;
    tr.push(
      Math.max(
        bars[i].high - bars[i].low,
        Math.abs(bars[i].high - prevClose),
        Math.abs(bars[i].low - prevClose)
      )
    );
  }
  const out: (number | null)[] = [];
  for (let i = 0; i < bars.length; i++) {
    if (i < period - 1) {
      out.push(null);
      continue;
    }
    const slice = tr.slice(i - period + 1, i + 1);
    out.push(slice.reduce((a, b) => a + b, 0) / period);
  }
  return out;
}

function findBarIndex(bars: PriceBar[], asOf: string): number {
  const t = new Date(asOf).getTime();
  if (Number.isNaN(t)) return -1;
  for (let i = bars.length - 1; i >= 0; i--) {
    if (new Date(bars[i].date).getTime() <= t) return i;
  }
  return -1;
}

interface EnrichedTrade {
  ticker: string;
  entry: string;
  exit: string;
  side: "long" | "short";
  pnl: number;
  hold_hours: number;
  bucket: "quick_stop" | "mid" | "survivor";
  outcome: "win" | "loss";
  // Entry-time features (computed on daily bars at or before entry)
  distance_from_20ma_pct: number | null;
  atr_pct: number | null;
  rsi_14: number | null;
  pct_from_20d_high: number | null;
  pct_from_20d_low: number | null;
  daily_change_pct: number | null;
}

function enrichTrade(t: BacktestTrade, dailyBarsByTicker: Map<string, PriceBar[]>): EnrichedTrade {
  const ticker = t.ticker ?? "UNKNOWN";
  const dailyBars = dailyBarsByTicker.get(ticker) ?? [];
  const entryIdx = findBarIndex(dailyBars, t.entry_date);
  const closes = dailyBars.map((b) => b.close);
  const ma20 = sma(closes, 20);
  const rsi14 = rsi(closes, 14);
  const atr20 = atr(dailyBars, 20);

  const holdHours = (new Date(t.exit_date).getTime() - new Date(t.entry_date).getTime()) / 1000 / 3600;
  const bucket: EnrichedTrade["bucket"] =
    holdHours < 100 ? "quick_stop" : holdHours < 300 ? "mid" : "survivor";

  let distance_from_20ma_pct: number | null = null;
  let atr_pct: number | null = null;
  let rsi_14: number | null = null;
  let pct_from_20d_high: number | null = null;
  let pct_from_20d_low: number | null = null;
  let daily_change_pct: number | null = null;

  if (entryIdx >= 19) {
    const entryClose = t.entry_price;
    const ma = ma20[entryIdx];
    if (ma !== null) distance_from_20ma_pct = ((entryClose - ma) / ma) * 100;
    const a = atr20[entryIdx];
    if (a !== null) atr_pct = (a / entryClose) * 100;
    rsi_14 = rsi14[entryIdx];
    const window = dailyBars.slice(entryIdx - 19, entryIdx + 1);
    const high20 = Math.max(...window.map((b) => b.high));
    const low20 = Math.min(...window.map((b) => b.low));
    pct_from_20d_high = ((entryClose - high20) / high20) * 100;
    pct_from_20d_low = ((entryClose - low20) / low20) * 100;
    if (entryIdx >= 1) {
      const prev = dailyBars[entryIdx - 1].close;
      daily_change_pct = ((dailyBars[entryIdx].close - prev) / prev) * 100;
    }
  }

  return {
    ticker,
    entry: t.entry_date,
    exit: t.exit_date,
    side: t.side,
    pnl: t.pnl,
    hold_hours: Number(holdHours.toFixed(1)),
    bucket,
    outcome: t.pnl > 0 ? "win" : "loss",
    distance_from_20ma_pct,
    atr_pct,
    rsi_14,
    pct_from_20d_high,
    pct_from_20d_low,
    daily_change_pct,
  };
}

function summarise(trades: EnrichedTrade[]) {
  const fields: (keyof EnrichedTrade)[] = [
    "distance_from_20ma_pct",
    "atr_pct",
    "rsi_14",
    "pct_from_20d_high",
    "pct_from_20d_low",
    "daily_change_pct",
  ];
  const out: Record<string, { mean: number; min: number; max: number; n: number } | null> = {};
  for (const f of fields) {
    const vals = trades
      .map((t) => t[f])
      .filter((v): v is number => v !== null && Number.isFinite(v));
    if (vals.length === 0) {
      out[f] = null;
      continue;
    }
    out[f] = {
      mean: Number((vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(3)),
      min: Number(Math.min(...vals).toFixed(3)),
      max: Number(Math.max(...vals).toFixed(3)),
      n: vals.length,
    };
  }
  return out;
}

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 500 });
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const algoId = url.searchParams.get("id");
  const window = (url.searchParams.get("window") ?? "1y") as "1m" | "3m" | "6m" | "1y" | "all";
  if (!algoId) return NextResponse.json({ error: "missing ?id=<algorithm_id>" }, { status: 400 });

  const { createAdminClient } = await import("@/lib/supabase/admin");
  const { runPortfolioBacktest } = await import("@/lib/market-data/portfolio-backtest");
  const { timeframeToInterval } = await import("@/lib/market-data/interval");
  const { fetchDailyPrices } = await import("@/lib/market-data/prices");
  const { getCachedPrices, savePricesToCache } = await import("@/lib/market-data/price-cache");
  const { fetchEconomicCalendar } = await import("@/lib/market-data/economic-calendar");

  const supabase = createAdminClient();
  const algoRes = await supabase.from("algorithms").select("*").eq("id", algoId).single();
  const algo = algoRes.data as unknown as
    | { rules: import("@/types/algorithm").AlgorithmRules; capital: number; user_id: string }
    | null;
  if (algoRes.error || !algo) return NextResponse.json({ error: "algorithm not found" }, { status: 404 });

  const watchlistRes = await supabase
    .from("algorithm_watchlist")
    .select("ticker")
    .eq("algorithm_id", algoId);
  const tickers = ((watchlistRes.data ?? []) as { ticker: string }[]).map((w) => w.ticker.toUpperCase());
  if (tickers.length === 0) return NextResponse.json({ error: "watchlist empty" }, { status: 400 });

  const interval = timeframeToInterval(algo.rules.timeframe);
  const pricesByTicker = new Map<string, PriceBar[]>();
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

  const WINDOW_MS: Record<string, number> = {
    "1m": 30 * 24 * 60 * 60 * 1000,
    "3m": 90 * 24 * 60 * 60 * 1000,
    "6m": 180 * 24 * 60 * 60 * 1000,
    "1y": 365 * 24 * 60 * 60 * 1000,
  };
  const sliced = new Map<string, PriceBar[]>();
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

  // Resample to daily for entry-time feature computation. This matches the
  // higherTfBars view that daily_bias would have seen at signal time.
  const dailyBarsByTicker = new Map<string, PriceBar[]>();
  for (const [ticker, prices] of sliced) {
    dailyBarsByTicker.set(ticker, resampleToDaily(prices));
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

  const result = runPortfolioBacktest(algo.rules, sliced, algo.capital, events);
  const enriched = result.trades.map((t) => enrichTrade(t, dailyBarsByTicker));

  const quickStopLosers = enriched.filter((t) => t.bucket === "quick_stop" && t.outcome === "loss");
  const midLosers = enriched.filter((t) => t.bucket === "mid" && t.outcome === "loss");
  const survivors = enriched.filter((t) => t.bucket === "survivor" && t.outcome === "win");
  const survivorLosers = enriched.filter((t) => t.bucket === "survivor" && t.outcome === "loss");

  return NextResponse.json({
    window,
    summary: {
      total_trades: result.total_trades,
      win_rate: result.win_rate,
      total_return: result.total_return,
    },
    feature_comparison: {
      quick_stop_losers: { count: quickStopLosers.length, ...summarise(quickStopLosers) },
      mid_losers: { count: midLosers.length, ...summarise(midLosers) },
      survivor_winners: { count: survivors.length, ...summarise(survivors) },
      survivor_losers: { count: survivorLosers.length, ...summarise(survivorLosers) },
    },
    trades: enriched,
  });
}
