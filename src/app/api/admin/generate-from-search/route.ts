/**
 * Admin endpoint: Wave 7 algorithm creation via combinatorial search.
 * Mirrors the user-facing server action but uses the admin client so
 * it can run without a session (for cron / smoke tests).
 *
 * Usage:
 *   curl -X POST -H "Authorization: Bearer $CRON_SECRET" \
 *     -H "Content-Type: application/json" \
 *     -d '{"user_id": "<uuid>", "capital": 20000, "monthly_target_pct": 5,
 *          "prefer_asset_classes": ["forex"]}' \
 *     "http://localhost:3000/api/admin/generate-from-search"
 *
 * Returns the created algorithm + the picked candidate (with full
 * walk-forward evidence) + the calibration result. No watchlist seeding
 * is needed in a separate call — the action persists watchlist rows
 * from the candidate's contributing symbols inline.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { generateAlgorithmFromSearchForUser } from "@/app/(dashboard)/algorithms/generate-from-search-actions";
import { verifyAdminAuth } from "@/lib/api/admin-auth";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const inputSchema = z.object({
  user_id: z.string().uuid(),
  capital: z.number().positive(),
  monthly_target_pct: z.number().min(0).max(200),
  prefer_asset_classes: z.array(z.string()).optional(),
  avoid_asset_classes: z.array(z.string()).optional(),
  prefer_symbols: z.array(z.string()).optional(),
  avoid_symbols: z.array(z.string()).optional(),
  name: z.string().optional(),
  description: z.string().optional(),
});

export async function POST(request: Request) {
  const authError = verifyAdminAuth(request);
  if (authError) return authError;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = inputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", issues: parsed.error.issues },
      { status: 400 }
    );
  }

  const { user_id, ...input } = parsed.data;
  const supabase = createAdminClient();
  const result = await generateAlgorithmFromSearchForUser(supabase, user_id, input);
  if (!result.success) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  return NextResponse.json(result.data);
}
