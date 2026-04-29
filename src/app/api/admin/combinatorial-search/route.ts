/**
 * Admin endpoint: combinatorial search runner. Smoke-test access for
 * Wave 7 step 2 — runs the curated grid against the user's
 * (capital, target, prefer/avoid) and returns the ranked candidates.
 *
 * Usage:
 *   curl -X POST -H "Authorization: Bearer $CRON_SECRET" \
 *     -H "Content-Type: application/json" \
 *     -d '{"capital": 20000, "monthly_target_pct": 10, "prefer_asset_classes": ["forex"]}' \
 *     "http://localhost:3000/api/admin/combinatorial-search"
 *
 * Returns:
 *   { candidates_evaluated, candidates_passed, top: [...], duration_ms }
 *
 * No DB writes — purely a search/score endpoint. PR-B will hook the
 * search into algorithm generation and persist the chosen candidate.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { runCombinatorialSearch } from "@/lib/algorithm/combinatorial-search";
import { loadDefaultPriceCorpus } from "@/lib/algorithm/combinatorial-search/price-loader";
import { verifyAdminAuth } from "@/lib/api/admin-auth";

export const dynamic = "force-dynamic";
// 5 min ceiling — the search is designed for ≤ 2 min, this is headroom
// for cold-cache runs that have to fetch every symbol's full history.
export const maxDuration = 300;

const inputSchema = z.object({
  capital: z.number().positive(),
  monthly_target_pct: z.number().min(0).max(200),
  prefer_asset_classes: z.array(z.string()).optional(),
  avoid_asset_classes: z.array(z.string()).optional(),
  prefer_symbols: z.array(z.string()).optional(),
  avoid_symbols: z.array(z.string()).optional(),
  max_candidates: z.number().int().positive().max(200).optional(),
  top_n: z.number().int().positive().max(20).optional(),
  include_evaluated: z.boolean().optional(),
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
  const { max_candidates, top_n, include_evaluated, ...input } = parsed.data;

  const result = await runCombinatorialSearch(input, loadDefaultPriceCorpus, {
    max_candidates,
    top_n,
    include_evaluated,
  });
  return NextResponse.json(result);
}
