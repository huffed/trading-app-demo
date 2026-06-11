"use server";

import { getAuthedUser } from "@/lib/supabase/get-authed-user";
import { rulesFromRow } from "@/lib/supabase/row-mappers";
import { type ActionResult } from "@/lib/types/action-result";
import type { AlgorithmRules, EntryCondition } from "@/types/algorithm";

export interface PositionEvent {
  id: string;
  event_type: string;
  details: Record<string, unknown> | null;
  created_at: string;
  ticker: string | null;
}

export interface PositionEntryContext {
  /** The algorithm's full entry condition list, in order. */
  conditions: EntryCondition[];
  /** Logic combinator the algorithm uses (all / any / n_of_m). */
  logic: AlgorithmRules["entry_logic"];
  /** Number of conditions that fired at the entry signal. From the
   *  signal_detected event matched by ticker + timestamp ≈ opened_at.
   *  Null when the signal_detected event can't be located (older
   *  positions before the event was logged consistently). */
  conditions_met: number | null;
  /** Total evaluable conditions at the time of entry. */
  conditions_total: number | null;
  /** Per-condition fired/not-fired array, parallel to `conditions`.
   *  Null for older positions logged before the engine emitted the
   *  breakdown. When non-null, length === conditions.length. */
  conditions_breakdown: boolean[] | null;
  /** Algorithm's primary timeframe — surfaced because pattern conditions
   *  may reference per-condition timeframes. */
  primary_timeframe: string;
}

/**
 * Fetch the activity_log events tied to this position via position_id.
 * Returns chronological events that name the position directly — does
 * NOT include algorithm-level manage_tick events (those have null
 * position_id and aggregate over all positions for the cycle).
 */
export async function getPositionEvents(
  positionId: string
): Promise<ActionResult<PositionEvent[]>> {
  try {
    const { supabase, user } = await getAuthedUser();
    const { data, error } = await supabase
      .from("activity_log")
      .select("id, event_type, details, created_at, ticker")
      .eq("user_id", user.id)
      .eq("position_id", positionId)
      .order("created_at", { ascending: true });
    if (error) return { success: false, error: error.message };
    return { success: true, data: (data ?? []) as PositionEvent[] };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Events fetch failed" };
  }
}

/**
 * Fetch the algorithm's entry condition list + the count of conditions
 * that fired at this position's entry. The signal_detected event
 * doesn't carry a position_id (the position doesn't exist yet when
 * the signal fires), so we match on ticker + a tight time window
 * around opened_at.
 *
 * Per-condition fire/no-fire detail requires a scan-engine change to
 * include the breakdown in signal_detected.details — currently the
 * event only logs the aggregate count.
 */
export async function getPositionEntryContext(
  positionId: string
): Promise<ActionResult<PositionEntryContext | null>> {
  try {
    const { supabase, user } = await getAuthedUser();
    const { data: pos, error: posErr } = await supabase
      .from("paper_positions")
      .select("id, ticker, algorithm_id, opened_at")
      .eq("id", positionId)
      .eq("user_id", user.id)
      .single();
    if (posErr) return { success: false, error: posErr.message };

    const { data: algo } = await supabase
      .from("algorithms")
      .select("rules")
      .eq("id", pos.algorithm_id)
      .single();
    if (!algo) return { success: true, data: null };
    const rules = rulesFromRow(algo.rules);

    // Match the signal_detected event by ticker + timestamp window
    // around opened_at. The scan engine emits signal_detected ~milli-
    // seconds before position_opened, so a ±60s window is generous.
    const openMs = new Date(pos.opened_at).getTime();
    const lo = new Date(openMs - 60_000).toISOString();
    const hi = new Date(openMs + 60_000).toISOString();
    const { data: signal } = await supabase
      .from("activity_log")
      .select("details")
      .eq("user_id", user.id)
      .eq("event_type", "signal_detected")
      .eq("ticker", pos.ticker)
      .gte("created_at", lo)
      .lte("created_at", hi)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const details = (signal?.details ?? null) as Record<string, unknown> | null;
    const conditionsMet =
      typeof details?.conditions_met === "number" ? (details.conditions_met as number) : null;
    const conditionsTotal =
      typeof details?.conditions_total === "number"
        ? (details.conditions_total as number)
        : rules.entry_conditions.length;
    const breakdownRaw = details?.conditions_breakdown;
    const conditionsBreakdown =
      Array.isArray(breakdownRaw) &&
      breakdownRaw.every((v) => typeof v === "boolean") &&
      breakdownRaw.length === rules.entry_conditions.length
        ? (breakdownRaw as boolean[])
        : null;

    return {
      success: true,
      data: {
        conditions: rules.entry_conditions,
        logic: rules.entry_logic,
        conditions_met: conditionsMet,
        conditions_total: conditionsTotal,
        conditions_breakdown: conditionsBreakdown,
        primary_timeframe: rules.timeframe,
      },
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Entry context fetch failed",
    };
  }
}
