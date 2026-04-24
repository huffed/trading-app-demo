import { createClient } from "@/lib/supabase/server";
import type { PriceBar } from "./types";

// Price data is refreshed once per day — cache for 23 hours so the latest
// bar is never more than ~1 day stale. Historical bars never change.
const CACHE_MAX_AGE_HOURS = 23;

export async function getCachedPrices(
  ticker: string,
  outputSize: string
): Promise<PriceBar[] | null> {
  const supabase = await createClient();
  const cutoff = new Date(Date.now() - CACHE_MAX_AGE_HOURS * 60 * 60 * 1000).toISOString();

  const { data } = await supabase
    .from("price_cache")
    .select("bars")
    .eq("ticker", ticker.toUpperCase())
    .eq("output_size", outputSize)
    .gte("fetched_at", cutoff)
    .limit(1)
    .single();

  if (!data) return null;
  return data.bars as PriceBar[];
}

export async function savePricesToCache(
  ticker: string,
  outputSize: string,
  bars: PriceBar[]
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
      bars,
      bar_count: bars.length,
      fetched_at: new Date().toISOString(),
    },
    { onConflict: "user_id,ticker,output_size" }
  );
}
