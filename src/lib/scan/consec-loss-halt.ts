/**
 * Consecutive-loss soft halt for live trading. Mirrors the backtest's
 * `prop_firm.consecutive_loss_daily_halt` — once N losing trades fire
 * in a row TODAY, no new entries open until the date rolls over. Open
 * positions continue to their stops/TPs (this is a discipline rule,
 * not a panic halt).
 *
 * **R-magnitude filter.** A loss only counts toward the streak if it
 * was ≥ 0.5R adverse (half a stop's worth of loss). The friend's "3
 * strikes" rule was designed for full-stop-loss streaks, not for tiny
 * stagnant-cut nips that close trades at -0.05R. Without this filter
 * a flurry of micro-cuts (e.g. four $8/$11 stagnant exits when the
 * gate fires aggressively after a parameter shift) would falsely
 * trip the halt. Wins / break-evens still terminate the streak the
 * way the rule expects; the filter only changes which losses count.
 *
 * Distinct from `daily-halt.ts` (DLL force-close) and from
 * `max_consecutive_losses` in the backtest (challenge-fail kill).
 */
import { pnlInUsd } from "@/lib/constants/markets";
import type { SupabaseClient } from "@supabase/supabase-js";

interface ClosedRow {
  realized_pnl: number | null;
  closed_at: string;
  ticker: string | null;
  side: "long" | "short" | null;
  entry_price: number | null;
  stop_loss_price: number | null;
  quantity: number | null;
}

export interface ConsecLossHaltResult {
  /** True iff the streak hit the configured threshold today. */
  tripped: boolean;
  /** Length of the active losing streak across today's closed trades —
   *  counting only losses ≥ 0.5R adverse. */
  streak: number;
  /** Threshold the streak is being measured against. */
  threshold: number;
}

/** Significant-loss cutoff. Losses below this fraction of the trade's
 *  full-stop value (1R) don't count toward the streak. 0.25 = quarter
 *  of a stop. Lowered from 0.5 (2026-05-05) after beyr1223h analysis
 *  showed bleed days had clusters of 0.3-0.5R llm_exit losses that
 *  were skipped under the old 0.5R threshold but still represented
 *  real damage (e.g. 04-09 had three losses 0.72R / 0.44R / 1R; the
 *  middle one was skipped, never reaching the 3-strike count even
 *  though the day was clearly bleeding). True micro stagnant-cut nips
 *  (≤ 0.05R) still don't count. */
const SIGNIFICANT_LOSS_R_THRESHOLD = 0.25;

/** True when a closed trade is a "significant" loss — pnl is negative
 *  AND its magnitude is ≥ 0.25R. Falls back to "any loss" when the SL
 *  fields are missing (very old rows, manual closes), so we never
 *  silently drop a real bad trade just because we couldn't compute R. */
function isSignificantLoss(row: ClosedRow): boolean {
  const pnl = row.realized_pnl ?? 0;
  if (pnl >= 0) return false;
  if (
    row.stop_loss_price == null ||
    row.entry_price == null ||
    row.side == null ||
    row.quantity == null ||
    row.ticker == null
  ) {
    return true; // missing SL info → treat as significant (conservative fallback)
  }
  const oneR = Math.abs(
    pnlInUsd(row.ticker, row.side, row.entry_price, row.stop_loss_price, row.quantity)
  );
  if (oneR <= 0) return true; // degenerate stop config; treat as significant
  return Math.abs(pnl) / oneR >= SIGNIFICANT_LOSS_R_THRESHOLD;
}

/**
 * Walks today's closed trades from most-recent backwards, counting how
 * many consecutive ≥ 0.5R losses sit at the end of the sequence.
 *
 * Streak rules:
 *   - Wins / break-evens (pnl ≥ 0) terminate the count immediately.
 *   - Significant losses (pnl < 0 AND ≥ 0.5R) increment the streak.
 *   - Micro losses (pnl < 0 AND < 0.5R) are SKIPPED — they don't reset
 *     the streak and don't count toward it. This way a stagnant-cut
 *     nip between two real SL hits doesn't accidentally insulate the
 *     bad day from triggering the halt.
 *
 * Returns `{ tripped: false }` when threshold is 0 (rule disabled) or
 * when there aren't enough significant closes today to evaluate.
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
    .select("realized_pnl, closed_at, ticker, side, entry_price, stop_loss_price, quantity")
    .eq("algorithm_id", algorithmId)
    .eq("status", "closed")
    .gte("closed_at", startIso)
    .order("closed_at", { ascending: false })
    .limit(50); // generous cap; the streak we care about is short by definition

  const rows = (data ?? []) as ClosedRow[];
  let streak = 0;
  for (const r of rows) {
    const pnl = r.realized_pnl ?? 0;
    if (pnl >= 0) break; // win or break-even resets the streak
    if (isSignificantLoss(r)) {
      streak++;
    }
    // Micro loss → skip without breaking the streak.
  }
  return { tripped: streak >= threshold, streak, threshold };
}
