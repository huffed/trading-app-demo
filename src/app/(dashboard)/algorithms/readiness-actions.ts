"use server";

import { runReadinessCheck, type ReadinessReport } from "@/lib/scan/readiness-check";
import { getAuthedUser } from "@/lib/supabase/get-authed-user";
import { type ActionResult } from "@/types/action-result";

/**
 * Operator-facing readiness check. Same logic as the admin endpoint —
 * "should I put real money behind this algo?" — but session-authed and
 * scoped to the caller's own algorithms via RLS. Use before flipping
 * `live_trading_enabled = true` for the first time, or before swapping
 * an algo to a new broker connection.
 */
export async function runAlgorithmReadinessCheck(
  algorithmId: string
): Promise<ActionResult<ReadinessReport>> {
  const { supabase } = await getAuthedUser();
  const result = await runReadinessCheck(supabase, algorithmId);
  if (!result.ok) {
    return { success: false, error: result.error };
  }
  return { success: true, data: result.report };
}
