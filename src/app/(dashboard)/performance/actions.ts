"use server";

import { buildStrategyMatrix, type StrategyMatrixRow } from "@/lib/performance/strategy-matrix";
import { createClient } from "@/lib/supabase/server";
import { type ActionResult } from "@/lib/types/action-result";

export async function getStrategyMatrixAction(): Promise<ActionResult<StrategyMatrixRow[]>> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { success: false, error: "Not authenticated" };

  try {
    const data = await buildStrategyMatrix(supabase);
    return { success: true, data };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Strategy matrix query failed";
    return { success: false, error: msg };
  }
}
