import type { PriceBar } from "./types";

const BASE_URL = "https://api.twelvedata.com";

interface TDValue {
  datetime: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}

interface TDResponse {
  values?: TDValue[];
  status?: string;
  message?: string;
  code?: number;
}

export async function fetchDailyPrices(
  symbol: string,
  outputSize: "compact" | "full" = "compact"
): Promise<PriceBar[]> {
  const apiKey = process.env.TWELVE_DATA_API_KEY;
  if (!apiKey) throw new Error("TWELVE_DATA_API_KEY is not set");

  const size = outputSize === "full" ? 5000 : 100;
  const url = `${BASE_URL}/time_series?symbol=${encodeURIComponent(symbol)}&interval=1day&outputsize=${size}&apikey=${apiKey}`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Twelve Data request failed: ${res.status}`);

  const data = (await res.json()) as TDResponse;

  if (data.code === 400 || data.status === "error") {
    throw new Error(data.message ?? `Invalid symbol: ${symbol}`);
  }
  if (!data.values || data.values.length === 0) {
    throw new Error("No price data returned from Twelve Data");
  }

  return data.values
    .map((v) => ({
      date: v.datetime,
      open: parseFloat(v.open),
      high: parseFloat(v.high),
      low: parseFloat(v.low),
      close: parseFloat(v.close),
      volume: parseInt(v.volume),
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}
