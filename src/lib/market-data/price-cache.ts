import { createClient } from "@/lib/supabase/server";
import type { BarInterval } from "./interval";
import type { PriceBar } from "./types";

// Daily bars refresh once per market day, intraday bars far more often.
// Tighter TTL on intraday so live signals don't act on stale data.
//
// Daily TTL extended 2026-05-04 from 23h → 7d. Rationale: 23h forced
// a re-fetch every weekend (cache invalid after Friday close + weekend),
// and when fetch fails (rate limit / API hiccup) the engine falls back
// to resampleToDaily(timeframe_bars) which produces <21 daily bars on
// 30m algos, breaking regime detection. 7-day TTL means slightly stale
// daily structure (acceptable for 14-bar regime calc) but cache always
// hits, eliminating the weekly cache-miss + fetch-fail cascade. Real
// fix is incremental cache refresh (only fetch the new daily bars and
// append) — queued as follow-up.
const DAILY_TTL_HOURS = 24 * 7;
const INTRADAY_TTL_HOURS = 1;

/** Hard cap on bars kept per (ticker, output_size, interval) row. Live
 *  fetches are 5000 bars; OANDA backfills run to ~28K on 30m / multi-year.
 *  100K is generous headroom (~50yr of 4h, ~6yr of 30m, ~2yr of 15m) and
 *  keeps the JSONB row under ~10MB. On overflow, oldest bars are dropped
 *  — recent history is what live trading and recent-window backtests
 *  actually read; multi-year backtests can re-run the OANDA backfill if
 *  they need older bars. */
const MAX_BARS_PER_ROW = 100_000;

export async function getCachedPrices(
  ticker: string,
  outputSize: string,
  interval: BarInterval = "1day"
): Promise<PriceBar[] | null> {
  const supabase = await createClient();
  const ttlHours = interval === "1day" ? DAILY_TTL_HOURS : INTRADAY_TTL_HOURS;
  const cutoff = new Date(Date.now() - ttlHours * 60 * 60 * 1000).toISOString();

  const { data } = await supabase
    .from("price_cache")
    .select("bars")
    .eq("ticker", ticker.toUpperCase())
    .eq("output_size", outputSize)
    .eq("interval", interval)
    .gte("fetched_at", cutoff)
    .limit(1)
    .single();

  if (!data) return null;
  return data.bars as PriceBar[];
}

/**
 * Merge `newBars` into the existing cached row by date — newer wins on
 * overlap, oldest dropped on overflow.
 *
 * Why: the unique key `(user_id, ticker, output_size, interval)` is
 * shared across the OANDA deep-history backfill (~28K bars on 30m) and
 * the live cron's Twelve Data fetch (5000 bars). A naive overwrite-upsert
 * truncated the deep tail every time the cron rehydrated the cache,
 * silently destroying the multi-year corpus the validation harnesses
 * depend on. Merge-on-write makes the cache append-only at the tail
 * while still letting live writes refresh the head.
 *
 * One extra round-trip per write — fine because every caller fires this
 * off the hot path (`.catch(() => {})` after returning a response).
 */
export async function savePricesToCache(
  ticker: string,
  outputSize: string,
  bars: PriceBar[],
  interval: BarInterval = "1day"
): Promise<void> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return;

  const tickerUpper = ticker.toUpperCase();

  // Read the existing JSONB so we can merge against it. Skip the
  // fetched_at filter — even an "expired" row's bars are valid data we
  // want to retain. The TTL is for getCachedPrices' staleness check,
  // not for write-side correctness.
  const { data: existing } = await supabase
    .from("price_cache")
    .select("bars")
    .eq("user_id", user.id)
    .eq("ticker", tickerUpper)
    .eq("output_size", outputSize)
    .eq("interval", interval)
    .maybeSingle();

  const existingBars = (existing?.bars as PriceBar[] | undefined) ?? [];

  // Dedupe by date string. Map insertion order is preserved, so we seed
  // with the existing bars (oldest → newest) and overlay the new ones —
  // any matching date keeps the newer payload (in case the API revised
  // a recently-printed bar).
  const byDate = new Map<string, PriceBar>();
  for (const b of existingBars) byDate.set(b.date, b);
  for (const b of bars) byDate.set(b.date, b);

  const merged = Array.from(byDate.values()).sort((a, b) =>
    a.date.localeCompare(b.date)
  );

  // Cap. JSONB row stays bounded even on degenerate fetches (e.g. a
  // bug that calls saveToCache with a per-bar interval). Drop oldest
  // since callers + harness both read recent-tail-first.
  const capped =
    merged.length > MAX_BARS_PER_ROW
      ? merged.slice(merged.length - MAX_BARS_PER_ROW)
      : merged;

  await supabase.from("price_cache").upsert(
    {
      user_id: user.id,
      ticker: tickerUpper,
      output_size: outputSize,
      interval,
      bars: capped,
      bar_count: capped.length,
      fetched_at: new Date().toISOString(),
    },
    { onConflict: "user_id,ticker,output_size,interval" }
  );
}
