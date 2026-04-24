import type { PriceBar } from "./types";

// In-memory cache — fastest layer, survives within a single server process.
const MEMORY_CACHE_TTL_MS = 60 * 60 * 1000;
const memoryCache = new Map<string, { data: PriceBar[]; fetchedAt: number }>();

/**
 * Fetch daily OHLCV prices with a provider fallback chain:
 *   Twelve Data (800/day) → Yahoo Finance (unlimited) → Alpha Vantage (25/day)
 *
 * Callers should wrap this with the Supabase price cache for persistence.
 */
export async function fetchDailyPrices(
  symbol: string,
  outputSize: "compact" | "full" = "compact"
): Promise<PriceBar[]> {
  const cacheKey = `${symbol.toUpperCase()}:${outputSize}`;
  const cached = memoryCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < MEMORY_CACHE_TTL_MS) {
    return cached.data;
  }

  const prices = await fetchWithFallback(symbol, outputSize);
  memoryCache.set(cacheKey, { data: prices, fetchedAt: Date.now() });
  return prices;
}

async function fetchWithFallback(
  symbol: string,
  outputSize: "compact" | "full"
): Promise<PriceBar[]> {
  // 1. Twelve Data (primary — 800 credits/day)
  try {
    const { fetchDailyPrices: fromTwelveData } = await import("./twelve-data");
    return await fromTwelveData(symbol, outputSize);
  } catch {
    // fall through to next provider
  }

  // 2. Yahoo Finance (fallback — unlimited, unofficial)
  try {
    const { fetchDailyPrices: fromYahoo } = await import("./yahoo-finance");
    return await fromYahoo(symbol, outputSize);
  } catch {
    // fall through to last resort
  }

  // 3. Alpha Vantage (last resort — 25 req/day)
  const { fetchDailyPrices: fromAlphaVantage } = await import("./alpha-vantage");
  return await fromAlphaVantage(symbol, outputSize);
}
