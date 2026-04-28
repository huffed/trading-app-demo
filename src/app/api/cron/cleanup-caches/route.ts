/**
 * Cron entrypoint: prune sentiment_cache + price_cache to keep table size
 * bounded. Both caches have client-side read TTLs but no DB-side cleanup,
 * so without this cron rows accumulate indefinitely.
 *
 * - sentiment_cache: calls the prune_sentiment_cache(retention_days)
 *   SECURITY DEFINER function shipped in migration 00022. Default 30 days.
 * - price_cache: deletes rows whose fetched_at is older than a generous
 *   multiple of the read TTL (23h daily / 1h intraday in price-cache.ts).
 *   We use 7 days for daily bars and 24h for intraday — long enough that a
 *   rerun of an old backtest still benefits from the cache, short enough
 *   that retired tickers don't bloat the table.
 *
 * Auth: Bearer ${CRON_SECRET} via verifyAdminAuth.
 *
 * Recommended crontab (self-hosted Mac): once per day, e.g. 02:30 UTC.
 *   30 2 * * * curl -fsS -H "Authorization: Bearer $CRON_SECRET" \
 *     "http://localhost:3000/api/cron/cleanup-caches"
 */
import { NextResponse } from "next/server";
import { verifyAdminAuth } from "@/lib/api/admin-auth";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const SENTIMENT_RETENTION_DAYS = 30;
const PRICE_DAILY_RETENTION_DAYS = 7;
const PRICE_INTRADAY_RETENTION_HOURS = 24;

export async function GET(request: Request) {
  const authError = verifyAdminAuth(request);
  if (authError) return authError;

  const supabase = createAdminClient();

  // No generated DB types — cast via `as never` to satisfy supabase-js
  // overloads (same pattern as /api/admin/prune-sentiment-cache).
  const sentimentResult = await supabase.rpc(
    "prune_sentiment_cache",
    { retention_days: SENTIMENT_RETENTION_DAYS } as never
  );
  if (sentimentResult.error) {
    logger.error("cleanup-caches", "prune_sentiment_cache failed", sentimentResult.error);
  }
  const sentimentPruned = (sentimentResult.data as number | null) ?? 0;

  const dailyCutoff = new Date(
    Date.now() - PRICE_DAILY_RETENTION_DAYS * 86_400_000
  ).toISOString();
  const intradayCutoff = new Date(
    Date.now() - PRICE_INTRADAY_RETENTION_HOURS * 3_600_000
  ).toISOString();

  const dailyDelete = await supabase
    .from("price_cache")
    .delete({ count: "exact" })
    .eq("interval", "1day")
    .lt("fetched_at", dailyCutoff);
  if (dailyDelete.error) {
    logger.error("cleanup-caches", "price_cache daily delete failed", dailyDelete.error);
  }

  const intradayDelete = await supabase
    .from("price_cache")
    .delete({ count: "exact" })
    .in("interval", ["1h", "4h"])
    .lt("fetched_at", intradayCutoff);
  if (intradayDelete.error) {
    logger.error(
      "cleanup-caches",
      "price_cache intraday delete failed",
      intradayDelete.error
    );
  }

  return NextResponse.json({
    sentiment_pruned: sentimentPruned,
    price_cache_daily_deleted: dailyDelete.count ?? 0,
    price_cache_intraday_deleted: intradayDelete.count ?? 0,
  });
}
