/**
 * Admin endpoint: manually evaluate performance drift for a given
 * algorithm. The scan engine runs the same check after each scan that
 * closes positions; this endpoint exists for one-off review without
 * waiting for the next scan tick.
 *
 * Returns the drift severity (none / warn / halt) plus the recent vs
 * baseline numbers. No side effects — does NOT halt the algo even if
 * severity is "halt"; just reports the verdict.
 *
 * Usage:
 *   curl -H "Authorization: Bearer $CRON_SECRET" \
 *     "http://localhost:3000/api/admin/check-drift?id=<algorithm_id>"
 */
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 500 });
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const algoId = url.searchParams.get("id");
  if (!algoId) return NextResponse.json({ error: "missing ?id=<algorithm_id>" }, { status: 400 });

  const { createAdminClient } = await import("@/lib/supabase/admin");
  const { detectDrift } = await import("@/lib/scan/drift-detector");

  const supabase = createAdminClient();
  const { data: algo } = await supabase
    .from("algorithms")
    .select("backtest_results")
    .eq("id", algoId)
    .single<{ backtest_results: import("@/types/algorithm").BacktestResults | null }>();
  const baseline = algo?.backtest_results ?? null;
  const result = await detectDrift(supabase, algoId, baseline);
  return NextResponse.json({ algorithm_id: algoId, ...result });
}
