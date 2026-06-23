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
import { emitCronIdle } from "@/lib/scan/cron-idle";
import { logActivity } from "@/lib/scan/helpers";
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
        errors_count: acc.errors_count + r.errors.length,
      }),
      { positions_inspected: 0, positions_closed: 0, positions_updated: 0, errors_count: 0 }
    );

    // Liveness heartbeat: emit once per tick regardless of whether any
    // positions were inspected. `manageActiveAlgorithms` skips algos with
    // zero open positions entirely, so without a route-level emit the
    // operator has no signal that the 5-min cron is alive between trades.
    // With ≥1 active algo we write `manage_tick` (any active algo's owner
    // satisfies the NOT NULL user_id). With 0 active algos we write
    // `cron_idle` via the SG.19 helper — same heartbeat purpose, semantic
    // distinction surfaced to the dashboard rail + dead-man RPC.
    const { data } = await supabase
      .from("algorithms")
      .select("user_id")
      .eq("status", "active")
      .limit(1)
      .maybeSingle();
    const anyAlgo = data as { user_id: string } | null;
    let cron_idle_emitted = false;
    if (anyAlgo) {
      await logActivity(supabase, anyAlgo.user_id, {
        algorithm_id: null,
        event_type: "manage_tick",
        details: { algorithms_inspected: results.length, ...totals },
      });
    } else {
      const idle = await emitCronIdle(supabase, "manage");
      cron_idle_emitted = idle.emitted;
    }

    return NextResponse.json({
      algorithms: results.length,
      ...totals,
      results,
      cron_idle_emitted,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    logger.error("manage-positions", "Tick failed", err);
    return NextResponse.json({ error: msg, code: "tick_failed" }, { status: 500 });
  }
}
