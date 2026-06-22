/**
 * Position-management cluster — manageExistingPosition + its private
 * helpers (evaluateStagnantExit, closePositionForExit). Extracted from
 * `scan/engine.ts` on 2026-06-22 (CB.H1 pass 17) so the engine
 * orchestrator stays focused on the scan loop.
 *
 * manageExistingPosition is the per-tick exit-trigger evaluator + close
 * orchestrator. Called from BOTH the scan loop AND the manage cron's
 * processTicker. The slim `AlgoForPositionMgmt` shape lets the manage
 * cron pass a minimal algorithm without the watchlist field.
 */
import {
  checkStagnantExit,
  resolveEntryBarIndex,
  type StagnantExitResult,
} from "@/lib/algorithm/stagnant-exit";
import { pnlInUsd, priceDeltaForRule } from "@/lib/constants/markets";
import { logger } from "@/lib/logger";
import type { PriceBar } from "@/lib/market-data/types";
import type { AlgorithmRules } from "@/types/algorithm";
import type { PaperPosition, PositionEvent } from "@/types/position";
import { checkExitTrigger } from "./exit-trigger";
import { logActivity } from "./helpers";
import { executeLiveExit, type BrokerExecutionContext } from "./live-execution";
import type { SupabaseClient } from "@supabase/supabase-js";

/** Slim algorithm shape needed by manageExistingPosition — id/name for
 *  logging and rules for the exit trigger check. */
export interface AlgoForPositionMgmt {
  id: string;
  name: string;
  rules: AlgorithmRules;
}

/** Resolve the stagnant-exit gate for a single open position. Returns
 *  null when the gate is disabled. Telemetry-rich `StagnantExitResult`
 *  otherwise — including non-firing decisions — so the caller can log
 *  MFE / current_r / bars_open even when the trade exits for some
 *  other reason. The intent of running the gate FIRST is to PREEMPT
 *  the SL hit on losers that aren't going to recover; recording an
 *  intra-bar SL fill as the exit_reason would obscure that contribution. */
function evaluateStagnantExit(
  position: PaperPosition,
  rules: AlgorithmRules,
  ticker: string,
  bars: PriceBar[]
): StagnantExitResult | null {
  if (!rules.stagnant_exit?.enabled) return null;
  const entryBarIndex = resolveEntryBarIndex(bars, position.opened_at);
  const stopDistance =
    position.stop_loss_price != null
      ? Math.abs(position.entry_price - position.stop_loss_price)
      : priceDeltaForRule(rules.stop_loss, position.entry_price, ticker);
  return checkStagnantExit({
    bars,
    entryBarIndex,
    currentBarIndex: bars.length - 1,
    entryPrice: position.entry_price,
    side: position.side,
    stopDistance,
    config: rules.stagnant_exit,
  });
}

export async function manageExistingPosition(
  supabase: SupabaseClient,
  userId: string,
  algo: AlgoForPositionMgmt,
  ticker: string,
  position: PaperPosition,
  bars: PriceBar[],
  closes: number[],
  livePrice: number | null,
  brokerCtx: BrokerExecutionContext | null,
  dailyBars: PriceBar[] | null
): Promise<{ closed: number; updated: number; closeEvent?: PositionEvent }> {
  const currentPrice = livePrice ?? closes[closes.length - 1];
  const unrealizedPnl = pnlInUsd(
    ticker,
    position.side,
    position.entry_price,
    currentPrice,
    position.quantity
  );

  const stagnantResult = evaluateStagnantExit(position, algo.rules, ticker, bars);
  const exitCheck = stagnantResult?.exit
    ? "stagnant_no_excursion"
    : checkExitTrigger(position, currentPrice, algo.rules, bars, closes, dailyBars);

  if (exitCheck) {
    return closePositionForExit({
      supabase,
      userId,
      algo,
      ticker,
      position,
      exitCheck,
      currentPrice,
      realizedPnl: unrealizedPnl,
      stagnantResult,
      brokerCtx,
    });
  }

  // status guard: a concurrent tick may have closed this row since we
  // fetched it — never scribble unrealized_pnl back onto a closed row.
  await supabase
    .from("paper_positions")
    .update({ current_price: currentPrice, unrealized_pnl: unrealizedPnl })
    .eq("id", position.id)
    .eq("status", "open");
  return { closed: 0, updated: 1 };
}

interface CloseExitArgs {
  supabase: SupabaseClient;
  userId: string;
  algo: AlgoForPositionMgmt;
  ticker: string;
  position: PaperPosition;
  exitCheck: string;
  currentPrice: number;
  realizedPnl: number;
  stagnantResult: StagnantExitResult | null;
  brokerCtx: BrokerExecutionContext | null;
}

/** Close path — DB update, broker mirror, activity log. Extracted so
 *  manageExistingPosition stays tight and so the close branch can be
 *  unit-tested independently of the price-management flow. */
async function closePositionForExit(
  a: CloseExitArgs
): Promise<{ closed: number; updated: number; closeEvent?: PositionEvent }> {
  // Atomic claim: only the first tick to flip open → closed proceeds to
  // the broker exit + close logging. The 5-min manage tick and 15-min
  // scan tick both walk open positions with no cross-tick lock, so a slow
  // tick can race this close — the loser must not re-fire executeLiveExit
  // (duplicate broker close) or double-log the close event.
  const { data: claimed, error: claimError } = await a.supabase
    .from("paper_positions")
    .update({
      current_price: a.currentPrice,
      exit_price: a.currentPrice,
      unrealized_pnl: 0,
      realized_pnl: a.realizedPnl,
      exit_reason: a.exitCheck,
      status: "closed",
      closed_at: new Date().toISOString(),
    })
    .eq("id", a.position.id)
    .eq("status", "open")
    .select("id");

  if (claimError) {
    logger.error(
      "scan-engine",
      `close update failed for position ${a.position.id} — skipping broker exit this tick`,
      claimError.message
    );
    return { closed: 0, updated: 0 };
  }
  if (!claimed || claimed.length === 0) {
    logger.warn(
      "scan-engine",
      `position ${a.position.id} already closed by a concurrent tick — skipping duplicate close`
    );
    return { closed: 0, updated: 0 };
  }

  if (a.brokerCtx) {
    await executeLiveExit({
      supabase: a.supabase,
      userId: a.userId,
      algorithmId: a.algo.id,
      paperPositionId: a.position.id,
      ticker: a.ticker,
      brokerPositionId: a.position.broker_position_id ?? null,
      closePrice: a.currentPrice,
      ctx: a.brokerCtx,
    });
  }

  let eventType = "position_closed";
  if (a.exitCheck === "stop_loss") eventType = "stop_loss_hit";
  else if (a.exitCheck === "take_profit") eventType = "take_profit_hit";

  await logActivity(a.supabase, a.userId, {
    algorithm_id: a.algo.id,
    position_id: a.position.id,
    event_type: eventType,
    ticker: a.ticker,
    details: {
      exit_price: a.currentPrice,
      realized_pnl: a.realizedPnl,
      exit_reason: a.exitCheck,
      stagnant_bars_open: a.stagnantResult?.bars_open,
      stagnant_max_bars: a.stagnantResult?.max_bars_threshold,
      stagnant_mfe_r: a.stagnantResult?.mfe_r,
      stagnant_current_r: a.stagnantResult?.current_r,
    },
  });

  return {
    closed: 1,
    updated: 0,
    closeEvent: { ticker: a.ticker, reason: a.exitCheck, pnl: a.realizedPnl, price: a.currentPrice },
  };
}
