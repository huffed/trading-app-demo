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

function toDateStr(ts: number): string {
  return new Date(ts * 1000).toISOString().split("T")[0];
}

export async function fetchDailyPrices(
  symbol: string,
  outputSize: "compact" | "full" = "compact"
): Promise<PriceBar[]> {
  const range = outputSize === "full" ? "5y" : "6mo";
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d`;

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
      date: toDateStr(timestamp[i]),
      open: o,
      high: h,
      low: l,
      close: c,
      volume: v ?? 0,
    });
  }

  return prices.sort((a, b) => a.date.localeCompare(b.date));
}
