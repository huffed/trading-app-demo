/**
 * Cron entrypoint: walk open paper positions across all active
 * algorithms and run the exit-trigger check. Designed to run at higher
 * cadence than scan-active-algorithms (typically every 5 minutes) so
 * intraday SL/TP and signal exits don't have to wait up to an hour.
 *
 * Auth: Bearer ${CRON_SECRET} via verifyAdminAuth.
 *
 * Usage:
 *   curl -H "Authorization: Bearer $CRON_SECRET" \
 *     "http://localhost:3000/api/cron/manage-positions"
 */
import { NextResponse } from "next/server";
import { verifyAdminAuth } from "@/lib/api/admin-auth";
import { logger } from "@/lib/logger";
import { manageActiveAlgorithms } from "@/lib/scan/manage";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(request: Request) {
  const authError = verifyAdminAuth(request);
  if (authError) return authError;

  const supabase = createAdminClient();
  try {
    const results = await manageActiveAlgorithms(supabase);
    const totals = results.reduce(
      (acc, r) => ({
        positions_inspected: acc.positions_inspected + r.positions_inspected,
        positions_closed: acc.positions_closed + r.positions_closed,
        positions_updated: acc.positions_updated + r.positions_updated,
      }),
      { positions_inspected: 0, positions_closed: 0, positions_updated: 0 }
    );
    return NextResponse.json({ algorithms: results.length, ...totals, results });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    logger.error("manage-positions", "Tick failed", err);
    return NextResponse.json({ error: msg, code: "tick_failed" }, { status: 500 });
  }
}
