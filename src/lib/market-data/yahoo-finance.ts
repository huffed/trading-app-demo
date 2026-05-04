import type { BarInterval } from "./interval";
import type { PriceBar } from "./types";

interface YFChartResult {
  chart?: {
    result?: Array<{
      timestamp?: number[];
      indicators?: {
        quote?: Array<{
          open?: (number | null)[];
          high?: (number | null)[];
          low?: (number | null)[];
          close?: (number | null)[];
          volume?: (number | null)[];
        }>;
      };
    }>;
    error?: { description?: string };
  };
}

function toDateStr(ts: number, interval: BarInterval): string {
  const d = new Date(ts * 1000);
  // Daily bars use YYYY-MM-DD; intraday bars need a full timestamp so the
  // backtest engine and chart can plot multiple bars per day.
  return interval === "1day" ? d.toISOString().split("T")[0] : d.toISOString();
}

// Yahoo intraday lookback limits: 1h ≤ 730d, finer intervals ≤ 60d.
const YAHOO_RANGE: Record<BarInterval, { compact: string; full: string; yahooInterval: string }> = {
  "1day": { compact: "6mo", full: "5y", yahooInterval: "1d" },
  "4h": { compact: "60d", full: "60d", yahooInterval: "1h" }, // Yahoo has no 4h — caller resamples upstream if needed
  "1h": { compact: "60d", full: "730d", yahooInterval: "1h" },
  "30min": { compact: "30d", full: "60d", yahooInterval: "30m" },
  "15min": { compact: "30d", full: "60d", yahooInterval: "15m" },
};

// Yahoo's forex pairs use the `=X` suffix (e.g. EURUSD=X), commodities use
// futures contracts. Stocks pass through unchanged. This is the only reason
// Yahoo can ever serve as a fallback for our forex/commodity universe — the
// raw `EUR/JPY` symbol that works for Twelve Data is rejected by Yahoo.
const COMMODITY_FUTURES: Record<string, string> = {
  "XAU/USD": "GC=F",
  "XAG/USD": "SI=F",
  WTI: "CL=F",
  BRENT: "BZ=F",
  NATGAS: "NG=F",
};

function toYahooSymbol(symbol: string): string {
  const upper = symbol.toUpperCase();
  if (COMMODITY_FUTURES[upper]) return COMMODITY_FUTURES[upper];
  if (/^[A-Z]{3}\/[A-Z]{3}$/.test(upper)) {
    return upper.replace("/", "") + "=X";
  }
  return symbol;
}

export async function fetchDailyPrices(
  symbol: string,
  outputSize: "compact" | "full" = "compact",
  interval: BarInterval = "1day"
): Promise<PriceBar[]> {
  const cfg = YAHOO_RANGE[interval];
  const range = outputSize === "full" ? cfg.full : cfg.compact;
  const yahooSym = toYahooSymbol(symbol);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSym)}?range=${range}&interval=${cfg.yahooInterval}`;

  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0" },
  });
  if (!res.ok) throw new Error(`Yahoo Finance request failed: ${res.status}`);

  const data = (await res.json()) as YFChartResult;

  if (data.chart?.error) {
    throw new Error(data.chart.error.description ?? `Invalid symbol: ${symbol}`);
  }

  const result = data.chart?.result?.[0];
  if (!result?.timestamp || !result.indicators?.quote?.[0]) {
    throw new Error("No price data returned from Yahoo Finance");
  }

  const { timestamp } = result;
  const q = result.indicators.quote[0];
  const prices: PriceBar[] = [];

  for (let i = 0; i < timestamp.length; i++) {
    const o = q.open?.[i];
    const h = q.high?.[i];
    const l = q.low?.[i];
    const c = q.close?.[i];
    const v = q.volume?.[i];
    if (o == null || h == null || l == null || c == null) continue;

    prices.push({
      date: toDateStr(timestamp[i], interval),
      open: o,
      high: h,
      low: l,
      close: c,
      volume: v ?? 0,
    });
  }

  return prices.sort((a, b) => a.date.localeCompare(b.date));
}
