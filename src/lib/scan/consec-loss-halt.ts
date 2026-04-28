/**
 * Consecutive-loss soft halt for live trading. Mirrors the backtest's
 * `prop_firm.consecutive_loss_daily_halt` — once N losing trades fire
 * in a row TODAY, no new entries open until the date rolls over. Open
 * positions continue to their stops/TPs (this is a discipline rule,
 * not a panic halt).
 *
 * Distinct from `daily-halt.ts` (DLL force-close) and from
 * `max_consecutive_losses` in the backtest (challenge-fail kill).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

interface ClosedRow {
  realized_pnl: number | null;
  closed_at: string;
}

export interface ConsecLossHaltResult {
  /** True iff the streak hit the configured threshold today. */
  tripped: boolean;
  /** Length of the active losing streak across today's closed trades. */
  streak: number;
  /** Threshold the streak is being measured against. */
  threshold: number;
}

/**
 * Walks today's closed trades from most-recent backwards, counting how
 * many consecutive losses sit at the end of the sequence. The first
 * non-loss (win or break-even) terminates the count — a winning trade
 * resets the streak just like the backtest does.
 *
 * Returns `{ tripped: false }` when threshold is 0 (rule disabled) or
 * when there aren't enough closes today to evaluate.
 */
export async function checkConsecutiveLossHalt(
  supabase: SupabaseClient,
  algorithmId: string,
  threshold: number
): Promise<ConsecLossHaltResult> {
  if (!threshold || threshold <= 0) {
    return { tripped: false, streak: 0, threshold: 0 };
  }
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const startIso = startOfDay.toISOString();

  const { data } = await supabase
    .from("paper_positions")
    .select("realized_pnl, closed_at")
    .eq("algorithm_id", algorithmId)
    .eq("status", "closed")
    .gte("closed_at", startIso)
    .order("closed_at", { ascending: false })
    .limit(50); // generous cap; the streak we care about is short by definition

  const rows = (data ?? []) as ClosedRow[];
  let streak = 0;
  for (const r of rows) {
    const pnl = r.realized_pnl ?? 0;
    if (pnl < 0) {
      streak++;
    } else {
      break;
    }
  }
  return { tripped: streak >= threshold, streak, threshold };
}
