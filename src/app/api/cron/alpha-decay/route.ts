/**
 * Cron entrypoint: G.4 alpha decay monitoring. Daily 09:00 UTC per
 * `scripts/canonical/ROADMAP.md` G.4 spec — iterate every active algo,
 * compute rolling 30d/90d Sharpe vs in-sample baseline, auto-pause any
 * algo whose decay sustained across both windows. Operator manually
 * un-pauses after review (no auto-recovery).
 *
 * Auth: Bearer ${CRON_SECRET} via verifyAdminAuth.
 *
 * 0-active-algos → returns evaluated:0 + emits cron_idle("decay") so
 * the dead-man stays green even when the demo gap is in effect.
 *
 * Usage:
 *   curl -H "Authorization: Bearer $CRON_SECRET" \
 *     "http://localhost:3000/api/cron/alpha-decay"
 */
import { NextResponse } from "next/server";
import { verifyAdminAuth } from "@/lib/api/admin-auth";
import { evaluateAndApplyAlphaDecay, DEFAULT_ALPHA_DECAY_CONFIG } from "@/lib/cohort/alpha-decay";
import { logger } from "@/lib/logger";
import { pickHeartbeatUserId } from "@/lib/scan/cron-idle";
import { logActivity } from "@/lib/scan/helpers";
import { createAdminClient } from "@/lib/supabase/admin";
import type { SupabaseClient } from "@supabase/supabase-js";

/** E2.25.i liveness — emit an `alpha_decay_tick` heartbeat on EVERY
 *  successful run so `last_alpha_decay_tick()` (migration 00050) lets the
 *  dead-man verify this safety-net cron is alive. Best-effort: a failed
 *  heartbeat write never fails the tick. */
async function emitAlphaDecayTick(
  supabase: SupabaseClient,
  details: Record<string, unknown>
): Promise<void> {
  // Fully best-effort: the heartbeat must NEVER affect the decay
  // evaluation or the response (a broken DB/mocked client just no-ops).
  try {
    const userId = await pickHeartbeatUserId(supabase);
    if (!userId) return;
    await logActivity(supabase, userId, {
      algorithm_id: null,
      event_type: "alpha_decay_tick",
      details,
    });
  } catch {
    /* heartbeat failed — the tick still ran; nothing to do */
  }
}

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(request: Request) {
  const authError = verifyAdminAuth(request);
  if (authError) return authError;

  const supabase = createAdminClient();
  try {
    const result = await evaluateAndApplyAlphaDecay(supabase, DEFAULT_ALPHA_DECAY_CONFIG);
    // E2.25.i: heartbeat on EVERY successful run (incl. 0-algos) so the
    // dead-man can prove this safety-net cron is alive. It failed silently
    // for days in the 2026-07 outage precisely because it logged nothing.
    await emitAlphaDecayTick(supabase, {
      evaluated: result.evaluated,
      paused: result.paused.length,
    });
    if (result.evaluated === 0) {
      return NextResponse.json({
        evaluated: 0,
        paused: 0,
        message: "no active algos — alpha-decay check skipped (heartbeat emitted)",
      });
    }
    return NextResponse.json({
      evaluated: result.evaluated,
      paused: result.paused.length,
      counts: result.counts,
      paused_algos: result.paused,
      generated_at: result.generated_at,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    logger.error("alpha-decay", "tick failed", err);
    return NextResponse.json({ error: msg, code: "alpha_decay_tick_failed" }, { status: 500 });
  }
}
