/**
 * Admin endpoint: prune sentiment_cache rows older than `retention_days`.
 *
 * Wraps the prune_sentiment_cache(int) Postgres function added in
 * migration 00022. Intended for daily cron — at 1 row per (user, ticker,
 * fetched_at) the table grows quickly when many users are active.
 *
 * Usage:
 *   curl -H "Authorization: Bearer $CRON_SECRET" \
 *     "http://localhost:3000/api/admin/prune-sentiment-cache?days=30"
 */
import { NextResponse } from "next/server";
import { verifyAdminAuth } from "@/lib/api/admin-auth";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const authError = verifyAdminAuth(request);
  if (authError) return authError;

  const url = new URL(request.url);
  const days = Number(url.searchParams.get("days") ?? "30");
  if (!Number.isFinite(days) || days < 1) {
    return NextResponse.json(
      { error: "days must be >= 1", code: "validation_error" },
      { status: 400 }
    );
  }

  const supabase = createAdminClient();
  // No generated DB types in this repo; cast the rpc handle to teach
  // TS about the function signature added in migration 00022.
  const rpc = supabase.rpc as unknown as (
    fn: "prune_sentiment_cache",
    args: { retention_days: number }
  ) => Promise<{ data: number | null; error: { message: string } | null }>;
  const { data, error } = await rpc("prune_sentiment_cache", { retention_days: days });

  if (error) {
    logger.error("prune-sentiment-cache", "RPC failed", error);
    return NextResponse.json({ error: error.message, code: "rpc_failed" }, { status: 500 });
  }

  const removed = data ?? 0;
  logger.info("prune-sentiment-cache", `removed ${removed} rows older than ${days}d`);
  return NextResponse.json({ removed, retention_days: days });
}
