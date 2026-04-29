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
  // Fetch every (symbol, interval) pair in parallel. On cold cache the
  // serial version was 42 × ~1.5s ≈ 60s for forex universe; parallel
  // brings that down to roughly the slowest single fetch (~2s).
  // Twelve Data's free tier is 800 credits/day with no per-second
  // burst limit on the time_series endpoint, so fan-out is safe.
  const fetchTasks: Array<Promise<{
    interval: string;
    symbol: string;
    bars: PriceBar[] | null;
  }>> = [];
  for (const interval of intervals) {
    for (const symbol of symbols) {
      fetchTasks.push(
        fetchOne(symbol, interval).then((bars) => ({ interval, symbol, bars }))
      );
    }
  }
  const fetched = await Promise.all(fetchTasks);
  for (const interval of intervals) {
    byInterval.set(interval, new Map<string, PriceBar[]>());
  }
  for (const { interval, symbol, bars } of fetched) {
    if (bars && bars.length >= MIN_BARS_PER_SYMBOL) {
      byInterval.get(interval)!.set(symbol, bars);
    }
  }

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
  } catch {
    return null;
  }
}
