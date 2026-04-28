/**
 * Admin endpoint: run the pair-quality evaluator on a specific algorithm
 * and report which pairs would be auto-paused. Bearer-auth via CRON_SECRET.
 *
 * The scan engine triggers this automatically after a scan that closes
 * trades. This endpoint exists for manual one-off evaluation — verifying
 * thresholds, debugging why a pair is or isn't being pruned, etc.
 *
 * Usage:
 *   curl -H "Authorization: Bearer $CRON_SECRET" \
 *     "http://localhost:3000/api/admin/evaluate-pairs?id=<algorithm_id>"
 */
import { NextResponse } from "next/server";
import { verifyAdminAuth } from "@/lib/api/admin-auth";
import { evaluateAndPrune } from "@/lib/scan/pair-quality";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const authError = verifyAdminAuth(request);
  if (authError) return authError;

  const url = new URL(request.url);
  const algoId = url.searchParams.get("id");
  if (!algoId) {
    return NextResponse.json({ error: "missing ?id=<algorithm_id>" }, { status: 400 });
  }

  const supabase = createAdminClient();
  const evals = await evaluateAndPrune(supabase, algoId);
  return NextResponse.json({
    algorithm_id: algoId,
    evaluated: evals.length,
    pruned_count: evals.filter((e) => e.pruned && e.reason !== "already_paused").length,
    results: evals,
  });
}
