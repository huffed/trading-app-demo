import type { PriceBar } from "./types";

const BASE_URL = "https://www.alphavantage.co/query";

interface AVDailyResponse {
  "Time Series (Daily)": Record<string, {
    "1. open": string;
    "2. high": string;
    "3. low": string;
    "4. close": string;
    "5. volume": string;
  }>;
  Note?: string;
  "Error Message"?: string;
}

export async function fetchDailyPrices(
  symbol: string,
  outputSize: "compact" | "full" = "compact"
): Promise<PriceBar[]> {
  const apiKey = process.env.ALPHA_VANTAGE_API_KEY;
  if (!apiKey) {
    throw new Error("ALPHA_VANTAGE_API_KEY is not set");
  }

  const url = `${BASE_URL}?function=TIME_SERIES_DAILY&symbol=${encodeURIComponent(symbol)}&outputsize=${outputSize}&apikey=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Alpha Vantage request failed: ${res.status}`);

  const data = (await res.json()) as AVDailyResponse;

  if (data["Error Message"]) {
    throw new Error(`Invalid symbol: ${symbol}`);
  }
  if (data.Note) {
    throw new Error("Alpha Vantage rate limit reached (25 requests/day)");
  }

  const timeSeries = data["Time Series (Daily)"];
  if (!timeSeries) throw new Error("No price data returned");

  return Object.entries(timeSeries)
    .map(([date, bar]) => ({
      date,
      open: parseFloat(bar["1. open"]),
      high: parseFloat(bar["2. high"]),
      low: parseFloat(bar["3. low"]),
      close: parseFloat(bar["4. close"]),
      volume: parseInt(bar["5. volume"]),
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}
