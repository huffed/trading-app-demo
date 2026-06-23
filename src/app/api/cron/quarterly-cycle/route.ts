/**
 * Cron entrypoint: H.5 quarterly research cycle. Auto-runs 1st of
 * Jan/Apr/Jul/Oct at 07:00 UTC per scripts/canonical/quarterly-
 * research-cycle.md. Generates the cycle report (4 spec'd artifacts:
 * feature library refresh, alpha library snapshot, decay report,
 * new-hypothesis log) and persists the markdown to /tmp for the
 * operator to review + copy into the repo if they want to archive
 * the cycle.
 *
 * Auth: Bearer ${CRON_SECRET} via verifyAdminAuth.
 *
 * Operator can also curl ad-hoc for an on-demand preview:
 *   curl -H "Authorization: Bearer $CRON_SECRET" \
 *     "http://localhost:3000/api/cron/quarterly-cycle"
 *
 * The route writes to `/tmp/quanttrader-cycles/<cycle_id>-research-cycle.md`
 * AND returns the full report (payload + markdown) in the JSON response.
 * Operator-owned archival: copy the file into the repo + commit only
 * cycles worth keeping (avoids automatic repo churn).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NextResponse } from "next/server";
import { verifyAdminAuth } from "@/lib/api/admin-auth";
import { buildQuarterlyCycleReport } from "@/lib/cohort/quarterly-cycle";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const CYCLES_DIR = "/tmp/quanttrader-cycles";

export async function GET(request: Request) {
  const authError = verifyAdminAuth(request);
  if (authError) return authError;

  const supabase = createAdminClient();
  try {
    const report = await buildQuarterlyCycleReport(supabase);
    // Persist to /tmp. mkdir is idempotent (recursive:true). Write
    // failures are logged but don't fail the response — the operator
    // still gets the report via the JSON body, the file is a convenience.
    let filePath: string | null = null;
    try {
      mkdirSync(CYCLES_DIR, { recursive: true });
      filePath = join(CYCLES_DIR, `${report.cycle_id}-research-cycle.md`);
      writeFileSync(filePath, report.markdown);
    } catch (writeErr) {
      logger.error("quarterly-cycle", "file write failed (response still includes markdown)", writeErr);
      filePath = null;
    }
    return NextResponse.json({
      cycle_id: report.cycle_id,
      generated_at: report.generated_at,
      next_cycle_at: report.next_cycle_at,
      feature_count: report.feature_library.total_count,
      alpha_count: report.alpha_library.length,
      decay_evaluated: report.decay.evaluated,
      decay_counts: report.decay.counts,
      file_path: filePath,
      markdown: report.markdown,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    logger.error("quarterly-cycle", "tick failed", err);
    return NextResponse.json({ error: msg, code: "quarterly_cycle_tick_failed" }, { status: 500 });
  }
}
