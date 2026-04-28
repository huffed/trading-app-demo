/**
 * Admin endpoint: aggregate readiness check for an algorithm. Thin
 * wrapper over `runReadinessCheck` — the same logic powers the UI
 * button via `runAlgorithmReadinessCheck` server action.
 *
 * Usage:
 *   curl -H "Authorization: Bearer $CRON_SECRET" \
 *     "http://localhost:3000/api/admin/readiness-check?id=<algo>"
 */
import { NextResponse } from "next/server";
import { verifyAdminAuth } from "@/lib/api/admin-auth";
import { runReadinessCheck } from "@/lib/scan/readiness-check";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: Request) {
  const authError = verifyAdminAuth(request);
  if (authError) return authError;

  const url = new URL(request.url);
  const algoId = url.searchParams.get("id");
  const windowDays = Number(url.searchParams.get("window_days") ?? "180");
  const stepDays = Number(url.searchParams.get("step_days") ?? "30");
  if (!algoId)
    {return NextResponse.json({ error: "missing ?id=<algorithm_id>" }, { status: 400 });}

  const result = await runReadinessCheck(createAdminClient(), algoId, {
    windowDays,
    stepDays,
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 404 });
  }
  return NextResponse.json(result.report);
}
