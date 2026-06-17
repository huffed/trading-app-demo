"use server";

import { buildEngineActivity, type EngineActivity } from "@/lib/cohort/engine-activity";
import {
  buildLiveMirrorEligibility,
  type AlgoEligibility,
} from "@/lib/cohort/live-mirror-eligibility";
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

/**
 * Fetch the live-mirror eligibility payload — for each PAPER algo,
 * checks the 15d / 5-trade / ±50% R milestone for paper→live promotion.
 * See `feedback_live_mirror_milestone` + `src/lib/cohort/live-mirror-eligibility.ts`.
 */
export async function getLiveMirrorEligibilityAction(): Promise<ActionResult<AlgoEligibility[]>> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { success: false, error: "Not authenticated" };

  try {
    const data = await buildLiveMirrorEligibility(supabase);
    return { success: true, data };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Eligibility query failed";
    return { success: false, error: msg };
  }
}
