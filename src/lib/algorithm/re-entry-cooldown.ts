/**
 * Re-entry cooldown gate — refuses new LLM-trader entries on the same
 * algorithm+ticker within N minutes of a recent loss exit. Closes the
 * race between a stop-out and the next bar's evaluation where the
 * consecutive-loss halt hasn't yet seen the just-closed loss.
 *
 * Incident 2026-05-12: 30m gold algo stopped out Trade #1 at 01:30:03
 * UTC for -$98. 19 seconds later (01:30:22 UTC), the same algo emitted
 * `enter_long` on a stale-cache bar and opened Trade #3 at 54 lots
 * (3.2× Trade #1's size, because tighter SL distance). Trade #3
 * stopped 10 min later for -$399. The `consecutive_loss_daily_halt: 2`
 * rule was correctly configured but only saw 1 loss at Trade #3's
 * open — it tripped at 02:00:21 ("2/2 losses today"), one entry too
 * late. Cumulative damage from the race: -$399 + market context for
 * subsequent decisions on the 15m algo (still in drawdown).
 *
 * Default cooldown = 1× the primary-TF bar duration. That's the
 * minimum "wait for one fresh bar of new information before re-firing"
 * rule — the same rationale that justifies the consec-loss halt
 * checking only at bar close boundaries. 30m algo → 30 min cooldown;
 * 15m → 15 min; 4h → 4h.
 *
 * Only loss-exits trigger the cooldown:
 *   - `stop_loss` / `stagnant_exit`: position closed adversely
 *   - any close with `realized_pnl < 0`: catches `exit_signal` losses
 *
 * Wins (TP, exit_signal with profit) don't trigger cooldown — those
 * indicate the LLM correctly read a setup, and an immediate
 * continuation entry on a strong trend is legitimate behaviour.
 */
import { timeframeToInterval, type BarInterval } from "@/lib/market-data/interval";
import type { SupabaseClient } from "@supabase/supabase-js";

function intervalMinutes(interval: BarInterval): number {
  switch (interval) {
    case "15min":
      return 15;
    case "30min":
      return 30;
    case "1h":
      return 60;
    case "4h":
      return 240;
    case "1day":
      return 1440;
  }
}

function defaultCooldownForTimeframe(timeframe: string): number {
  return intervalMinutes(timeframeToInterval(timeframe));
}

export interface ReEntryCooldownResult {
  block: boolean;
  status: "no_recent_close" | "last_was_win" | "in_cooldown" | "cooldown_elapsed";
  /** Cooldown window in minutes that was applied. */
  cooldown_minutes: number;
  /** Time since last close in minutes (undefined when no close found). */
  elapsed_minutes?: number;
  /** ID of the most recent closed position. */
  last_close_id?: string;
  last_exit_reason?: string | null;
  last_realized_pnl?: number | null;
  reason?: string;
}

/**
 * Returns block:true when a loss exit on the same (algo, ticker) closed
 * within the cooldown window. No-op when there's no close history, when
 * the last close was a win, or when enough time has elapsed.
 */
export async function checkReEntryCooldown(args: {
  supabase: SupabaseClient;
  algorithmId: string;
  ticker: string;
  timeframe: string;
  /** Override default cooldown (in minutes). */
  cooldownMinutes?: number;
  /** Override "now" — for tests. */
  now?: Date;
}): Promise<ReEntryCooldownResult> {
  const cooldown = args.cooldownMinutes ?? defaultCooldownForTimeframe(args.timeframe);
  const now = args.now ?? new Date();

  const { data: lastClosed } = await args.supabase
    .from("paper_positions")
    .select("id, exit_reason, realized_pnl, closed_at")
    .eq("algorithm_id", args.algorithmId)
    .eq("ticker", args.ticker)
    .eq("status", "closed")
    .order("closed_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!lastClosed || !lastClosed.closed_at) {
    return {
      block: false,
      status: "no_recent_close",
      cooldown_minutes: cooldown,
    };
  }

  const realizedPnl = lastClosed.realized_pnl == null ? null : Number(lastClosed.realized_pnl);
  const exitReason = lastClosed.exit_reason as string | null;
  const isLoss =
    exitReason === "stop_loss" ||
    exitReason === "stagnant_exit" ||
    exitReason === "stagnant_no_excursion" || // E2.25.f: legacy alias, pre-canonicalization
    (realizedPnl != null && realizedPnl < 0);

  if (!isLoss) {
    return {
      block: false,
      status: "last_was_win",
      cooldown_minutes: cooldown,
      last_close_id: lastClosed.id as string,
      last_exit_reason: exitReason,
      last_realized_pnl: realizedPnl,
    };
  }

  const closedAt = new Date(lastClosed.closed_at as string);
  const elapsedMin = (now.getTime() - closedAt.getTime()) / 60_000;

  if (elapsedMin < cooldown) {
    return {
      block: true,
      status: "in_cooldown",
      cooldown_minutes: cooldown,
      elapsed_minutes: elapsedMin,
      last_close_id: lastClosed.id as string,
      last_exit_reason: exitReason,
      last_realized_pnl: realizedPnl,
      reason: `Re-entry cooldown: ${elapsedMin.toFixed(1)} min since last loss close (${exitReason ?? "n/a"}, $${realizedPnl?.toFixed(2) ?? "n/a"}) < ${cooldown.toFixed(0)} min cooldown — wait for at least one fresh primary-TF bar of new information before re-firing on this ticker`,
    };
  }

  return {
    block: false,
    status: "cooldown_elapsed",
    cooldown_minutes: cooldown,
    elapsed_minutes: elapsedMin,
    last_close_id: lastClosed.id as string,
    last_exit_reason: exitReason,
    last_realized_pnl: realizedPnl,
  };
}
