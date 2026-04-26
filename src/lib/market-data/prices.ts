/**
 * Price data fetcher with 3-tier caching and provider fallback.
 *
 * Cache layers (fastest → slowest):
 *   1. In-memory Map (1h TTL, same server process only)
 *   2. Supabase price_cache table (persistent, managed by callers via price-cache.ts)
 *   3. API call via provider fallback chain
 *
 * Provider fallback chain:
 *   Twelve Data (800 credits/day) → Yahoo Finance (unlimited, unofficial) → Alpha Vantage (25 req/day)
 *
 * Callers should check the Supabase cache first (via getCachedPrices) before
 * calling this function. This function handles the in-memory cache and API fallback.
 */
import type { BarInterval } from "./interval";
import type { PriceBar } from "./types";

const MEMORY_CACHE_TTL_MS = 60 * 60 * 1000;
const memoryCache = new Map<string, { data: PriceBar[]; fetchedAt: number }>();

/**
 * Fetch OHLCV prices with a provider fallback chain:
 *   Twelve Data (800/day) → Yahoo Finance (unlimited) → Alpha Vantage (25/day, daily-only)
 *
 * `interval` controls the bar size. Alpha Vantage only serves daily bars,
 * so it's skipped automatically for intraday requests.
 *
 * Callers should wrap this with the Supabase price cache for persistence.
 */
export async function fetchDailyPrices(
  symbol: string,
  outputSize: "compact" | "full" = "compact",
  interval: BarInterval = "1day"
): Promise<PriceBar[]> {
  const cacheKey = `${symbol.toUpperCase()}:${outputSize}:${interval}`;
  const cached = memoryCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < MEMORY_CACHE_TTL_MS) {
    return cached.data;
  }

  const prices = await fetchWithFallback(symbol, outputSize, interval);
  memoryCache.set(cacheKey, { data: prices, fetchedAt: Date.now() });
  return prices;
}

async function fetchWithFallback(
  symbol: string,
  outputSize: "compact" | "full",
  interval: BarInterval
): Promise<PriceBar[]> {
  // Provider fallback chain — each catch logs and falls through to the next.
  // The final provider throws on failure (no silent swallowing).

  // 1. Twelve Data (primary — 800 credits/day, supports all intervals)
  try {
    const { fetchDailyPrices: fromTwelveData } = await import("./twelve-data");
    return await fromTwelveData(symbol, outputSize, interval);
  } catch (e) {
    console.warn(`[prices] Twelve Data failed for ${symbol}:`, e instanceof Error ? e.message : e);
  }

  // 2. Yahoo Finance (fallback — unlimited, supports 1h; 4h is approximated via 1h)
  try {
    const { fetchDailyPrices: fromYahoo } = await import("./yahoo-finance");
    return await fromYahoo(symbol, outputSize, interval);
  } catch (e) {
    console.warn(
      `[prices] Yahoo Finance failed for ${symbol}:`,
      e instanceof Error ? e.message : e
    );
  }

  // 3. Alpha Vantage (last resort — daily bars only). Throws if intraday was requested
  // and the upstream providers both failed.
  if (interval !== "1day") {
    throw new Error(
      `No intraday data available for ${symbol} at ${interval} (Alpha Vantage is daily-only).`
    );
  }
  const { fetchDailyPrices: fromAlphaVantage } = await import("./alpha-vantage");
  return await fromAlphaVantage(symbol, outputSize);
}
