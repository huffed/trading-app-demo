"use server";

import {
  buildBrokerHealthSummary,
  type BrokerHealthOptions,
  type BrokerHealthSummary,
} from "@/lib/cohort/broker-health";
import {
  buildCohortReport,
  type CohortReport,
  type CohortReportOptions,
} from "@/lib/cohort/cohort-report";
import {
  buildDriftSummary,
  type DriftSummary,
  type DriftSummaryOptions,
} from "@/lib/cohort/drift-summary";
import { buildEngineActivity, type EngineActivity } from "@/lib/cohort/engine-activity";
import {
  buildLiveMirrorEligibility,
  type AlgoEligibility,
} from "@/lib/cohort/live-mirror-eligibility";
import { createClient } from "@/lib/supabase/server";
import { type ActionResult } from "@/types/action-result";

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

/**
 * SG.6 (2026-06-22 NIGHT LATE): cohort attribution report for the
 * /reports Cohort tab. Shares aggregation with the weekly CLI cron
 * (`scripts/cohort-report.ts`) via `src/lib/cohort/cohort-report.ts`.
 *
 * Authenticated via the user's server-side supabase client — RLS
 * scopes llm_decisions + paper_positions to user_id.
 */
export async function getCohortReportAction(
  opts: CohortReportOptions = {}
): Promise<ActionResult<CohortReport>> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { success: false, error: "Not authenticated" };

  try {
    const data = await buildCohortReport(supabase, opts);
    return { success: true, data };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Cohort report query failed";
    return { success: false, error: msg };
  }
}

/**
 * SG.5 (2026-06-22 NIGHT LATE): drift summary for the /reports Drift tab.
 * Returns per-algo current drift state (via detectDrift) + recent
 * drift_halt/drift_warn events from activity_log. RLS-scoped via the
 * user's server-side supabase client.
 */
export async function getDriftSummaryAction(
  opts: DriftSummaryOptions = {}
): Promise<ActionResult<DriftSummary>> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { success: false, error: "Not authenticated" };

  try {
    const data = await buildDriftSummary(supabase, opts);
    return { success: true, data };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Drift summary query failed";
    return { success: false, error: msg };
  }
}

/**
 * SG.9 (2026-06-22 NIGHT LATE): broker health alerts for the /reports
 * Brokers tab. Pure-read aggregation from broker_connections +
 * algorithms — does NOT call live broker APIs from the UI thread
 * (filed SG.9.1 below for the live-snapshot cron). RLS-scoped via
 * the user's server-side supabase client.
 */
export async function getBrokerHealthAction(
  opts: BrokerHealthOptions = {}
): Promise<ActionResult<BrokerHealthSummary>> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { success: false, error: "Not authenticated" };

  try {
    const data = await buildBrokerHealthSummary(supabase, opts);
    return { success: true, data };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Broker health query failed";
    return { success: false, error: msg };
  }
}
