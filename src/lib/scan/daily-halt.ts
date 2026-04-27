/**
 * Daily-loss-limit halt for live trading. Mirrors what the backtest engine
 * does (`enforcePropFirm`'s halt branch) for the live scan path.
 *
 * Triggered at the start of every scan: sums today's realised + unrealised
 * P&L, compares against `capital × dll × halt_pct%`, and if the threshold
 * is breached, force-closes every open position (broker + paper) and
 * disables live_trading_enabled on the algorithm so subsequent scans skip
 * mirroring entirely. The user manually re-enables once they've reviewed
 * what happened — we deliberately don't auto-resume the next day because
 * the halt is a meaningful event worth a human eyeball.
 *
 * Day boundary is UTC midnight. FTMO actually uses CET, so this is off by
 * 1-2 hours; close enough for a defensive halt buffered at 80% of DLL.
 */
import type { AlgorithmRules } from "@/types/algorithm";
import { flattenAlgorithmPositions } from "./flatten";
import { logActivity } from "./helpers";
import type { SupabaseClient } from "@supabase/supabase-js";

export interface DailyHaltCheck {
  /** True iff today's drawdown crossed the halt threshold. */
  tripped: boolean;
  /** Today's P&L as a percentage of capital. Negative for loss. */
  todaysPnlPct: number;
  /** Halt threshold in percentage points (e.g. -4 for 80% of 5% DLL). */
  thresholdPct: number;
  realized: number;
  unrealized: number;
}

interface ClosedRow {
  realized_pnl: number | null;
}
interface OpenRow {
  unrealized_pnl: number | null;
}

/**
 * Measure today's P&L vs the halt threshold without taking any action.
 * Caller decides whether to call `executeDailyHalt`.
 */
export async function checkDailyLossHalt(
  supabase: SupabaseClient,
  algorithmId: string,
  capital: number,
  dailyLossLimitPct: number,
  haltPct: number = 100
): Promise<DailyHaltCheck> {
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const startIso = startOfDay.toISOString();

  const { data: closedToday } = await supabase
    .from("paper_positions")
    .select("realized_pnl")
    .eq("algorithm_id", algorithmId)
    .eq("status", "closed")
    .gte("closed_at", startIso);

  const { data: openNow } = await supabase
    .from("paper_positions")
    .select("unrealized_pnl")
    .eq("algorithm_id", algorithmId)
    .eq("status", "open");

  const realized = ((closedToday ?? []) as ClosedRow[]).reduce(
    (s, r) => s + (r.realized_pnl ?? 0),
    0
  );
  const unrealized = ((openNow ?? []) as OpenRow[]).reduce(
    (s, r) => s + (r.unrealized_pnl ?? 0),
    0
  );

  const todaysPnlPct = capital > 0 ? ((realized + unrealized) / capital) * 100 : 0;
  const thresholdPct = -dailyLossLimitPct * (haltPct / 100);
  return {
    tripped: todaysPnlPct <= thresholdPct,
    todaysPnlPct,
    thresholdPct,
    realized,
    unrealized,
  };
}

/**
 * Halt the algorithm: flatten every open position (broker + paper) and
 * disable live trading so subsequent scans don't mirror new entries.
 */
export async function executeDailyHalt(
  supabase: SupabaseClient,
  userId: string,
  algorithmId: string,
  check: DailyHaltCheck
): Promise<void> {
  const flattened = await flattenAlgorithmPositions(
    supabase,
    algorithmId,
    "daily_loss_halt"
  );
  await supabase
    .from("algorithms")
    .update({ live_trading_enabled: false })
    .eq("id", algorithmId);
  await logActivity(supabase, userId, {
    algorithm_id: algorithmId,
    event_type: "daily_loss_halt",
    details: {
      todays_pnl_pct: Number(check.todaysPnlPct.toFixed(3)),
      threshold_pct: Number(check.thresholdPct.toFixed(3)),
      realized: Number(check.realized.toFixed(2)),
      unrealized: Number(check.unrealized.toFixed(2)),
      positions_flattened: flattened.length,
    },
  });
}

/**
 * Convenience wrapper for the scan engine: read the algo's prop_firm rule,
 * run the check, and halt if tripped. Returns true iff a halt fired.
 */
export async function maybeHaltOnDailyLoss(
  supabase: SupabaseClient,
  userId: string,
  algo: { id: string; capital: number; rules: AlgorithmRules }
): Promise<boolean> {
  const pf = algo.rules.prop_firm;
  if (!pf?.daily_loss_limit) return false;
  const check = await checkDailyLossHalt(
    supabase,
    algo.id,
    algo.capital,
    pf.daily_loss_limit,
    pf.daily_loss_halt_pct ?? 100
  );
  if (!check.tripped) return false;
  await executeDailyHalt(supabase, userId, algo.id, check);
  return true;
}
