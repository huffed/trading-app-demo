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

  await supabase.from("price_cache").upsert(
    {
      user_id: user.id,
      ticker: ticker.toUpperCase(),
      output_size: outputSize,
      interval,
      bars,
      bar_count: bars.length,
      fetched_at: new Date().toISOString(),
    },
    { onConflict: "user_id,ticker,output_size,interval" }
  );
}
