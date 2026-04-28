/**
 * Cron entrypoint: detect active algorithms whose hourly scan has gone
 * stale. The host machine is a Mac that can sleep — when it does, the
 * scan-active-algorithms cron silently misses ticks and the operator has
 * no surface to discover that until trades come back open the next day.
 *
 * Threshold of 90 minutes = 1.5× the hourly scan cadence. Smaller than
 * that and a slow scan trips a false alarm; larger and Mac-sleep through
 * a full hour goes unnoticed.
 *
 * For each stale algorithm we both `logger.error` (so a tail -f catches it
 * during interactive monitoring) and write an `activity_log` row with
 * `event_type: "scan_overdue"` so the operator can review the day boundary
 * post-hoc. Activity-log inserts are scoped to the algo's owner user_id —
 * service-role admin client bypasses RLS but we still set user_id
 * correctly so per-user dashboards show the right entries.
 *
 * Auth: Bearer ${CRON_SECRET} via verifyAdminAuth.
 *
 * Recommended crontab (self-hosted Mac): once an hour, e.g. on the :05.
 *   5 * * * * curl -fsS -H "Authorization: Bearer $CRON_SECRET" \
 *     "http://localhost:3000/api/cron/heartbeat"
 */
import { NextResponse } from "next/server";
import { verifyAdminAuth } from "@/lib/api/admin-auth";
import { logger } from "@/lib/logger";
import { logActivity } from "@/lib/scan/helpers";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const STALE_THRESHOLD_MINUTES = 90;

interface StaleAlgo {
  id: string;
  user_id: string;
  name: string;
  last_scanned_at: string | null;
  created_at: string;
}

export async function GET(request: Request) {
  const authError = verifyAdminAuth(request);
  if (authError) return authError;

  const supabase = createAdminClient();
  const cutoffMs = Date.now() - STALE_THRESHOLD_MINUTES * 60 * 1000;
  const cutoffIso = new Date(cutoffMs).toISOString();

  // Two stale cases: (a) scanned at least once but the last scan is older
  // than the threshold; (b) never scanned and old enough that a healthy
  // cron would have caught up by now.
  const { data, error } = await supabase
    .from("algorithms")
    .select("id, user_id, name, last_scanned_at, created_at")
    .eq("status", "active")
    .or(`last_scanned_at.lt.${cutoffIso},and(last_scanned_at.is.null,created_at.lt.${cutoffIso})`);
  if (error) {
    logger.error("heartbeat", "query failed", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const stale = (data ?? []) as StaleAlgo[];
  for (const algo of stale) {
    const referenceMs = algo.last_scanned_at
      ? new Date(algo.last_scanned_at).getTime()
      : new Date(algo.created_at).getTime();
    const minutesStale = Math.round((Date.now() - referenceMs) / 60000);
    const reason = algo.last_scanned_at
      ? `last scan was ${minutesStale}m ago (threshold ${STALE_THRESHOLD_MINUTES}m)`
      : `never scanned, created ${minutesStale}m ago`;

    logger.error(
      "heartbeat",
      `Algorithm "${algo.name}" (${algo.id}) scan overdue — ${reason}`
    );

    await logActivity(supabase, algo.user_id, {
      algorithm_id: algo.id,
      event_type: "scan_overdue",
      details: {
        minutes_since_last_scan: minutesStale,
        threshold_minutes: STALE_THRESHOLD_MINUTES,
        last_scanned_at: algo.last_scanned_at,
      },
    });
  }

  return NextResponse.json({
    threshold_minutes: STALE_THRESHOLD_MINUTES,
    stale_count: stale.length,
    stale: stale.map((a) => ({
      id: a.id,
      name: a.name,
      last_scanned_at: a.last_scanned_at,
    })),
  });
}
