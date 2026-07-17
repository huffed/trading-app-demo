/**
 * Price data fetcher with 3-tier caching and provider fallback.
 *
 * Cache layers (fastest → slowest):
 *   1. In-memory Map (1h TTL, same server process only)
 *   2. Supabase price_cache table (persistent, managed by callers via price-cache.ts)
 *   3. API call via provider fallback chain
 *
 * Provider fallback chain:
 *   OANDA (practice, unlimited) → Twelve Data (800 credits/day) → Yahoo Finance (unlimited, unofficial) → Alpha Vantage (25 req/day)
 *
 * OANDA promoted to head 2026-05-12 after Twelve Data repeatedly stalled
 * on intraday refreshes (the bar-staleness gate refused every 15m/30m
 * scan for hours that morning). OANDA's the same source we backfilled
 * 27,718 30m bars from in 2026-05-06 with zero issues. Twelve Data
 * stays as fallback so we don't lose redundancy.
 *
 * Callers should check the Supabase cache first (via getCachedPrices) before
 * calling this function. This function handles the in-memory cache and API fallback.
 */
import { intervalMinutes, type BarInterval } from "./interval";
import { parseBarDate } from "./parse-bar-date";
import { getCachedPrices, savePricesToCache } from "./price-cache";
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
 *
 * `forceRefresh` (default false) bypasses the in-memory cache and hits
 * the provider on every call. The live cron sets this when the cached
 * tail is stale — without it the 1h in-memory TTL keeps returning the
 * same too-old bars even after the Supabase cache is rotated. The fresh
 * result is written back to the in-memory cache so subsequent reads
 * within the TTL still hit (and so the same bars persist across multi-
 * ticker scans in one tick).
 */
export async function fetchDailyPrices(
  symbol: string,
  outputSize: "compact" | "full" = "compact",
  interval: BarInterval = "1day",
  forceRefresh = false
): Promise<PriceBar[]> {
  const cacheKey = `${symbol.toUpperCase()}:${outputSize}:${interval}`;
  if (!forceRefresh) {
    const cached = memoryCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < MEMORY_CACHE_TTL_MS) {
      return cached.data;
    }
  }

  const prices = await fetchWithFallback(symbol, outputSize, interval);
  memoryCache.set(cacheKey, { data: prices, fetchedAt: Date.now() });
  return prices;
}

/**
 * Read cached prices for (ticker, interval), force-refresh from the
 * provider when the cached tail is older than one full primary-TF bar
 * duration. Live cron scans use this to guarantee `bars[last]` reflects
 * the most-recently-closed bar — without it, both the in-memory cache
 * (1h TTL in this file) and the Supabase cache (1h TTL in price-cache.ts)
 * keep returning identical too-old data for up to an hour, which the
 * bar-staleness gate then refuses across multiple consecutive scans.
 *
 * Threshold = 1.0× `intervalMinutes(interval)`. The bar-staleness gate
 * fires at 1.5×, so a fresh fetch happens BEFORE the gate would block
 * under normal conditions. When the provider fails (rate limit, network),
 * the cached (stale) bars are returned and the gate handles the refusal
 * downstream.
 *
 * `liveCron` is the opt-in switch. When false (default) callers get the
 * old behaviour: cache TTL controls freshness, no force-refresh path.
 * Daily-interval reads under liveCron refresh past a 26h age margin
 * (E2.25.c) — the 7-day Supabase read TTL is kept for backtest loaders
 * but must not gate the live daily_bias feed, which needs the previous
 * completed session, not a week-old one.
 */
export async function getFreshPricesForScan(
  ticker: string,
  outputSize: "compact" | "full",
  interval: BarInterval,
  liveCron = true
): Promise<PriceBar[]> {
  let prices = await getCachedPrices(ticker, outputSize, interval);
  if (!prices) {
    prices = await fetchDailyPrices(ticker, outputSize, interval);
    savePricesToCache(ticker, outputSize, prices, interval).catch(() => {});
    return prices;
  }

  if (!liveCron) return prices;

  const latest = prices[prices.length - 1];
  if (!latest) return prices;
  // UTC-explicit parse — bar dates are "YYYY-MM-DD HH:MM:SS" without
  // a TZ marker, default `new Date(...)` would skew by host-TZ offset.
  const latestMs = parseBarDate(latest.date).getTime();
  if (!Number.isFinite(latestMs)) return prices;

  const ageMs = Date.now() - latestMs;
  // E2.25.c: D1 used to be exempted from the live fresh-tail refresh
  // (7-day cache TTL), which let daily_bias — now a required entry
  // condition on every live algo — run on a daily close up to ~7 days
  // stale while the backtest sees a complete series. A NY-session daily
  // bar legitimately ages to ~24-25h just before the next session
  // closes, so refresh only past a 26h margin: this catches a genuinely
  // missing completed session without churning a fetch every scan.
  // Intraday intervals keep the 1-bar threshold. DQ.4's off-grid guard
  // protects the row if a fallback provider serves a different D1
  // boundary during the refresh.
  const refreshAgeMs =
    interval === "1day" ? 26 * 60 * 60_000 : intervalMinutes(interval) * 60_000;
  if (ageMs <= refreshAgeMs) return prices;

  try {
    const fresh = await fetchDailyPrices(ticker, outputSize, interval, true);
    savePricesToCache(ticker, outputSize, fresh, interval).catch(() => {});
    return fresh;
  } catch {
    // Provider failed — return what we have. Downstream bar-staleness
    // gate (1.5× threshold) will refuse the entry if data is too old
    // to act on. Don't swallow the refusal here by faking freshness.
    return prices;
  }
}

async function fetchWithFallback(
  symbol: string,
  outputSize: "compact" | "full",
  interval: BarInterval
): Promise<PriceBar[]> {
  const providerErrors: string[] = [];

  try {
    const { fetchDailyPrices: fromOanda } = await import("./oanda");
    return await fromOanda(symbol, outputSize, interval);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    providerErrors.push(`oanda: ${msg}`);
    console.warn(`[prices] OANDA failed for ${symbol}: ${msg}`);
  }

  try {
    const { fetchDailyPrices: fromTwelveData } = await import("./twelve-data");
    return await fromTwelveData(symbol, outputSize, interval);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    providerErrors.push(`twelve-data: ${msg}`);
    console.warn(`[prices] Twelve Data failed for ${symbol}: ${msg}`);
  }

  try {
    const { fetchDailyPrices: fromYahoo } = await import("./yahoo-finance");
    return await fromYahoo(symbol, outputSize, interval);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    providerErrors.push(`yahoo: ${msg}`);
    console.warn(`[prices] Yahoo Finance failed for ${symbol}: ${msg}`);
  }

  // Alpha Vantage is daily-only — for intraday requests, surface the
  // upstream provider errors so we can actually diagnose why both failed.
  if (interval !== "1day") {
    throw new Error(
      `No intraday data for ${symbol} at ${interval}. ${providerErrors.join(" | ")}`
    );
  }
  try {
    const { fetchDailyPrices: fromAlphaVantage } = await import("./alpha-vantage");
    return await fromAlphaVantage(symbol, outputSize);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    providerErrors.push(`alpha-vantage: ${msg}`);
    throw new Error(`All price providers failed for ${symbol}: ${providerErrors.join(" | ")}`);
  }
}
