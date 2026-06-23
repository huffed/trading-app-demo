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
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(request: Request) {
  const authError = verifyAdminAuth(request);
  if (authError) return authError;

  const supabase = createAdminClient();
  try {
    const result = await evaluateAndApplyAlphaDecay(supabase, DEFAULT_ALPHA_DECAY_CONFIG);
    if (result.evaluated === 0) {
      // Zero-active-algos no-op. Don't emit cron_idle here — alpha-decay
      // runs once daily and the SG.19 cron_idle path is designed for the
      // 5/15-min crons that need the dead-man heartbeat. The daily cron
      // failing to log a row is not a dead-man signal.
      return NextResponse.json({
        evaluated: 0,
        paused: 0,
        message: "no active algos — alpha-decay check skipped",
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
