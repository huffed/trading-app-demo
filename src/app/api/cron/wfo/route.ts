/**
 * Cron entrypoint: G.5 walk-forward optimization re-fit. Monthly per
 * `scripts/canonical/ROADMAP.md` G.5 spec — for each active algo,
 * re-run the Layer B 96-variant geometry sweep on the rolling 12-month
 * window ending today + propose / apply updates when best-by-DSR
 * differs by more than the buffer.
 *
 * Auth: Bearer ${CRON_SECRET} via verifyAdminAuth.
 *
 * Mode:
 *   - DRY_RUN=1 (default in query string + cron crontab) → computes
 *     proposals, returns them, writes NOTHING to DB. First 2-3 monthly
 *     cycles run dry to verify parameters don't flap.
 *   - DRY_RUN=0 → actually UPDATEs algorithms.rules when buffer passes
 *     AND geometry differs; writes wfo_rules_updated audit event per
 *     change. Operator flips after dry-run cycles confirm stability.
 *
 * 0-active-algos → returns evaluated:0 + skipped:[].
 *
 * Usage:
 *   # default DRY_RUN=1
 *   curl -H "Authorization: Bearer $CRON_SECRET" \
 *     "http://localhost:3000/api/cron/wfo"
 *
 *   # apply mode
 *   curl -H "Authorization: Bearer $CRON_SECRET" \
 *     "http://localhost:3000/api/cron/wfo?dry_run=0"
 */
import { NextResponse } from "next/server";
import { verifyAdminAuth } from "@/lib/api/admin-auth";
import { evaluateAndApplyWfo, DEFAULT_WFO_CONFIG } from "@/lib/algo-search/walk-forward-opt";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
// 96 backtests × N active algos × ~5s each could blow the default 60s
// edge runtime cap. Cap at the route maxDuration 300s; algos that exceed
// this in real life mean the sweep is the wrong tool (handle as the
// roadmap H phase work).
export const maxDuration = 300;

export async function GET(request: Request) {
  const authError = verifyAdminAuth(request);
  if (authError) return authError;

  const url = new URL(request.url);
  const dryRunParam = url.searchParams.get("dry_run");
  // Default DRY_RUN=true. Only the explicit string "0" flips it off — any
  // other value (including missing) is treated as dry. Conservative gate:
  // the operator must EXPLICITLY type ?dry_run=0 to live-update parameters.
  const dryRun = dryRunParam !== "0";

  const supabase = createAdminClient();
  try {
    const result = await evaluateAndApplyWfo(supabase, { dry_run: dryRun, config: DEFAULT_WFO_CONFIG });
    return NextResponse.json({
      dry_run: result.dry_run,
      evaluated: result.evaluated,
      proposal_count: result.proposals.length,
      skipped_count: result.skipped.length,
      applied_count: result.applied.length,
      proposals: result.proposals.map((p) => ({
        algorithm_id: p.algorithm_id,
        algorithm_name: p.algorithm_name,
        current_dsr: p.current_dsr,
        best_dsr: p.best_dsr,
        dsr_improvement: p.dsr_improvement,
        passes_buffer: p.passes_buffer,
        rules_changed: p.rules_changed,
        trades_in_window: p.trades_in_window,
        window_start: p.window_start,
        window_end: p.window_end,
      })),
      skipped: result.skipped,
      applied: result.applied,
      generated_at: result.generated_at,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    logger.error("wfo", "tick failed", err);
    return NextResponse.json({ error: msg, code: "wfo_tick_failed" }, { status: 500 });
  }
}
