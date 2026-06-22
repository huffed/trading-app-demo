/**
 * Default price-corpus loader for the combinatorial search engine.
 * Pulls bars per symbol per timeframe from the Supabase price_cache
 * first, falling back to the live API chain (Twelve Data → Yahoo →
 * Alpha Vantage). Same flow the readiness check uses, so the search
 * sees the same price tape live trading would see.
 *
 * Decoupled from the search engine itself so unit tests can supply a
 * synthetic loader without spinning up Supabase + network mocks.
 */
import { logger } from "@/lib/logger";
import { timeframeToInterval } from "@/lib/market-data/interval";
import { getCachedPrices, savePricesToCache } from "@/lib/market-data/price-cache";
import { fetchDailyPrices } from "@/lib/market-data/prices";
import type { PriceBar } from "@/lib/market-data/types";

/** Minimum bars per symbol/timeframe to be eligible for the corpus.
 *  Walk-forward needs ~30 bars per window × 3 windows + step margin.
 *  100 is a safe floor that drops too-thinly-traded symbols silently. */
const MIN_BARS_PER_SYMBOL = 100;

export async function loadDefaultPriceCorpus(
  symbols: string[],
  timeframes: string[]
): Promise<Map<string, Map<string, PriceBar[]>>> {
  // We only fetch bars for the timeframes that have an underlying
  // BarInterval (1h, 4h, 1day). Pattern conditions reference timeframes
  // like "1d" / "4h" too — those map to the same intervals via
  // timeframeToInterval.
  const intervals = new Set<ReturnType<typeof timeframeToInterval>>();
  const intervalByTf = new Map<string, ReturnType<typeof timeframeToInterval>>();
  for (const tf of timeframes) {
    const iv = timeframeToInterval(tf);
    intervals.add(iv);
    intervalByTf.set(tf, iv);
  }

  // Cache key: BarInterval → Map<symbol, bars>. We fetch each unique
  // interval once and re-use across timeframe aliases (so "1h" and
  // "60m" don't double up).
  const byInterval = new Map<string, Map<string, PriceBar[]>>();
  for (const interval of intervals) {
    byInterval.set(interval, new Map<string, PriceBar[]>());
  }

  // Twelve Data plan caps us at 8 credits per minute on the time_series
  // endpoint. A naïve Promise.all over 14 symbols × 3 intervals = 42
  // fetches blows through that — the API silently 429s and the operator
  // sees wall-clock dominated by retry backoffs. Cache hits don't count
  // against the limit, so we only batch when actually fetching.
  const tasks: Array<{
    interval: ReturnType<typeof timeframeToInterval>;
    symbol: string;
  }> = [];
  for (const interval of intervals) {
    for (const symbol of symbols) tasks.push({ interval, symbol });
  }
  await fetchRateLimited(tasks, 8, async ({ interval, symbol }) => {
    const bars = await fetchOne(symbol, interval);
    if (bars && bars.length >= MIN_BARS_PER_SYMBOL) {
      byInterval.get(interval)!.set(symbol, bars);
    }
  });

  // Map back from caller-facing timeframe strings → bar maps. Multiple
  // timeframe strings can resolve to the same interval (e.g. "1h" and
  // "60m" both → "1h"); they share the same bar set.
  const out = new Map<string, Map<string, PriceBar[]>>();
  for (const [tf, iv] of intervalByTf) {
    const bars = byInterval.get(iv);
    if (bars) out.set(tf, bars);
  }
  return out;
}

async function fetchOne(
  symbol: string,
  interval: ReturnType<typeof timeframeToInterval>
): Promise<PriceBar[] | null> {
  let bars = await getCachedPrices(symbol, "full", interval);
  if (bars && bars.length > 0) return bars;
  try {
    bars = await fetchDailyPrices(symbol, "full", interval);
    savePricesToCache(symbol, "full", bars, interval).catch(() => {});
    return bars;
  } catch (err) {
    // CB.M7.b (2026-06-20): warn-on-swallow — combinatorial search drops
    // this symbol silently on fetch failure; surface in logs.
    logger.warn("combinatorial-search", `fetchOne(${symbol}, ${interval}) failed`, err);
    return null;
  }
}

/**
 * Rate-limited batch executor. Runs `fn` over `items` in batches of
 * `perMinute` size, waiting out the remainder of each 60-second window
 * before starting the next batch. Cache hits inside `fn` are still
 * eligible for parallel execution within the batch — only actual API
 * calls draw down the credit budget. The first batch fires immediately;
 * subsequent batches sleep just enough to respect the floor.
 *
 * Safe to call when items.length ≤ perMinute (zero waits issued).
 * Errors inside `fn` propagate after settling the batch; callers handle
 * per-item failure inside `fn` (this helper only orchestrates timing).
 */
async function fetchRateLimited<T>(
  items: T[],
  perMinute: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  const windowMs = 60_000;
  for (let i = 0; i < items.length; i += perMinute) {
    const batch = items.slice(i, i + perMinute);
    const started = Date.now();
    await Promise.all(batch.map(fn));
    const isLastBatch = i + perMinute >= items.length;
    if (isLastBatch) break;
    const elapsed = Date.now() - started;
    const wait = windowMs - elapsed;
    if (wait > 0) {
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}
