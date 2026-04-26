import type { PriceBar, RealTimeQuote } from "./types";

const BASE_URL = "https://api.twelvedata.com";

/**
 * Fetch the exchange rate for a currency pair (e.g., "USD/GBP").
 * Uses the /price endpoint — 1 credit per call.
 */
export async function fetchExchangeRate(from: string, to: string): Promise<number> {
  if (from === to) {
    return 1;
  }

  const apiKey = process.env.TWELVE_DATA_API_KEY;
  if (!apiKey) {
    throw new Error("TWELVE_DATA_API_KEY is not set");
  }

  const pair = `${from}/${to}`;
  const url = `${BASE_URL}/price?symbol=${encodeURIComponent(pair)}&apikey=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Exchange rate request failed: ${res.status}`);
  }

  const data = await res.json();
  const price = parseFloat(data.price);
  if (isNaN(price)) {
    throw new Error(`Invalid exchange rate for ${pair}`);
  }
  return price;
}

interface TDQuoteResponse {
  symbol?: string;
  close?: string;
  previous_close?: string;
  change?: string;
  percent_change?: string;
  timestamp?: number;
  status?: string;
  message?: string;
  code?: number;
}

/**
 * Fetch real-time price quote for a single ticker.
 * Uses the /price endpoint (1 credit per call, returns latest price only).
 */
export async function fetchRealTimeQuote(symbol: string): Promise<RealTimeQuote> {
  const apiKey = process.env.TWELVE_DATA_API_KEY;
  if (!apiKey) {
    throw new Error("TWELVE_DATA_API_KEY is not set");
  }

  const url = `${BASE_URL}/quote?symbol=${encodeURIComponent(symbol)}&apikey=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Twelve Data quote failed: ${res.status}`);
  }

  const data = (await res.json()) as TDQuoteResponse;
  if (data.code === 400 || data.status === "error") {
    throw new Error(data.message ?? `Invalid symbol: ${symbol}`);
  }
  if (!data.close) {
    throw new Error(`No quote data for ${symbol}`);
  }

  return {
    symbol: symbol.toUpperCase(),
    price: parseFloat(data.close),
    previousClose: data.previous_close ? parseFloat(data.previous_close) : null,
    change: data.change ? parseFloat(data.change) : null,
    changePercent: data.percent_change ? parseFloat(data.percent_change) : null,
    timestamp: data.timestamp ?? Math.floor(Date.now() / 1000),
  };
}

/**
 * Fetch real-time quotes for multiple tickers in a single API call.
 * Twelve Data supports comma-separated symbols (1 credit per symbol).
 */
export async function fetchBatchQuotes(symbols: string[]): Promise<Map<string, number>> {
  const apiKey = process.env.TWELVE_DATA_API_KEY;
  if (!apiKey) {
    throw new Error("TWELVE_DATA_API_KEY is not set");
  }
  if (symbols.length === 0) {
    return new Map();
  }

  const symbolList = symbols.map((s) => encodeURIComponent(s)).join(",");
  const url = `${BASE_URL}/price?symbol=${symbolList}&apikey=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Twelve Data batch price failed: ${res.status}`);
  }

  const data = await res.json();
  const prices = new Map<string, number>();

  // Single symbol returns { price: "123.45" }, multiple returns { SYM: { price: "123.45" } }
  if (symbols.length === 1) {
    const price = parseFloat(data.price);
    if (!isNaN(price)) {
      prices.set(symbols[0].toUpperCase(), price);
    }
  } else {
    for (const sym of symbols) {
      const entry = data[sym.toUpperCase()];
      if (entry?.price) {
        const price = parseFloat(entry.price);
        if (!isNaN(price)) {
          prices.set(sym.toUpperCase(), price);
        }
      }
    }
  }

  return prices;
}

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
    .map((v) => {
      const vol = parseInt(v.volume);
      return {
        date: v.datetime,
        open: parseFloat(v.open),
        high: parseFloat(v.high),
        low: parseFloat(v.low),
        close: parseFloat(v.close),
        volume: Number.isFinite(vol) ? vol : 0,
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}
