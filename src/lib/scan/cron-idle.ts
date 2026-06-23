/**
 * Cron-idle event emission for the dead-man heartbeat (SG.19).
 *
 * Both the scan cron + manage cron normally write activity_log rows on
 * every tick — scan_completed (or scan_started + scan_completed pair)
 * for scan; manage_tick for manage. With 0 active algos there's nothing
 * to walk, so each cron used to return silently. That broke two things:
 *   1. The GitHub Actions dead-man (last_scan_tick + last_manage_tick
 *      RPCs) treated the absence of rows as "cron is dead" and fired
 *      a false alarm.
 *   2. The dashboard heartbeat rail rendered "stale ✗" red even though
 *      the cron itself was healthy.
 *
 * cron_idle is the explicit "ran, nothing to do" beat. One row per tick
 * per cron, tagged with `details.cron in ('scan','manage')`. Migration
 * 00046 extends both RPCs to count cron_idle rows alongside their
 * primary event types.
 *
 * Shared by both /api/cron/scan-active-algorithms + /api/cron/manage-positions.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { logActivity } from "./helpers";

export type CronKind = "scan" | "manage";

export interface EmitCronIdleResult {
  emitted: boolean;
  /** Set only when `emitted=false` so the caller can log why. */
  skipped_reason?: "no_user_id_available";
}

/** Pick any user_id for the cron_idle row. activity_log.user_id is
 *  NOT NULL but the event is system-level (not user-attributable in a
 *  meaningful way). Single-operator app → any algo's owner is fine;
 *  with 0 algos in the table we fall back to auth.users via the admin
 *  client. Returns null only when both queries come back empty (a
 *  fresh project with no user yet — cron has nothing to log anyway). */
async function pickHeartbeatUserId(supabase: SupabaseClient): Promise<string | null> {
  const { data: algo } = await supabase
    .from("algorithms")
    .select("user_id")
    .limit(1)
    .maybeSingle();
  if (algo) return (algo as { user_id: string }).user_id;
  // Service-role-only fallback: list one auth user. supabase-js's auth.admin
  // is typed on SupabaseClient (always present); the method itself errors at
  // runtime when called without the service role key. The cron routes use
  // createAdminClient() so the call is valid. We only read .id — the User
  // type from @supabase/auth-js has many more fields but the narrow access
  // pattern is what makes the try/catch a sufficient fallback (any error,
  // type mismatch, or empty list → null → emit is skipped gracefully).
  try {
    const { data, error } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1 });
    if (error) return null;
    return data?.users?.[0]?.id ?? null;
  } catch {
    return null;
  }
}

/** Write a single `cron_idle` activity_log row for the given cron.
 *  Callers invoke this when their active-algo query returned 0 rows.
 *  Idempotent per tick (one call → one row). */
export async function emitCronIdle(
  supabase: SupabaseClient,
  cron: CronKind,
): Promise<EmitCronIdleResult> {
  const userId = await pickHeartbeatUserId(supabase);
  if (!userId) return { emitted: false, skipped_reason: "no_user_id_available" };
  await logActivity(supabase, userId, {
    algorithm_id: null,
    event_type: "cron_idle",
    details: { cron, active_algos: 0 },
  });
  return { emitted: true };
}
