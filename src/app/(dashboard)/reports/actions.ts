"use server";

import { buildEngineActivity, type EngineActivity } from "@/lib/cohort/engine-activity";
import { createClient } from "@/lib/supabase/server";
import { type ActionResult } from "@/lib/types/action-result";

/**
 * Fetch the engine-activity payload for the /reports page.
 * Shares the aggregation logic with the CLI cohort report
 * (`scripts/cohort-report.ts`) via `src/lib/cohort/engine-activity.ts`.
 *
 * Authenticated via the user's server-side supabase client — RLS
 * scopes algorithms / activity_log / llm_decisions to user_id.
 */
export async function getEngineActivityAction(
  days = 7
): Promise<ActionResult<EngineActivity>> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { success: false, error: "Not authenticated" };

  try {
    const data = await buildEngineActivity(supabase, days);
    return { success: true, data };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Engine activity query failed";
    return { success: false, error: msg };
  }
}
