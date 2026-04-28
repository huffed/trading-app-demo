/**
 * Admin endpoint: close every open paper position for a given algorithm AND
 * mirror the close to the broker via MetaApi. Bearer-auth guarded by the
 * same CRON_SECRET as the cron route.
 *
 * Usage:
 *   curl -X POST -H "Authorization: Bearer $CRON_SECRET" \
 *     "http://localhost:3000/api/admin/flatten-algo?id=<algorithm_id>"
 */
import { NextResponse } from "next/server";
import { verifyAdminAuth } from "@/lib/api/admin-auth";
import { flattenAlgorithmPositions } from "@/lib/scan/flatten";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(request: Request) {
  const authError = verifyAdminAuth(request);
  if (authError) return authError;

  const url = new URL(request.url);
  const algoId = url.searchParams.get("id");
  if (!algoId) {
    return NextResponse.json({ error: "missing ?id=<algorithm_id>" }, { status: 400 });
  }

  const supabase = createAdminClient();
  const results = await flattenAlgorithmPositions(supabase, algoId, "manual");
  return NextResponse.json({ flattened: results.length, results });
}
