/**
 * LLM-trader in-position actions — the `move_be` and `exit` decision
 * branches extracted from `entry-llm-trader.ts` in CB.H1 (2026-06-22).
 *
 * Both functions are terminal: they execute the position-state change,
 * log it, and return `{ opened: 0 }` so the caller does
 * `return await executeLlmMoveBe(...)`. Neither opens a new position.
 *
 * Why pair these two:
 *  - Both operate on `currentPosition` (no-op + log when flat)
 *  - Both update `paper_positions` directly + emit broker-mirror calls
 *    where applicable
 *  - Both share the same "LLM-decided in-trade action" semantic; the
 *    decision-dispatch in the orchestrator reads cleaner when both are
 *    a single import.
 *
 * The `hold` decision stays inline in the orchestrator (17 lines, just
 * a log); the `enter_long`/`enter_short` branches stay inline too
 * because they're coupled with the post-decision gate ladder
 * (RANGING/capped/dry-run/spread/drift) that would also need extracting.
 */
import { pnlInUsd } from "@/lib/constants/markets";
import type { PaperPosition } from "@/types/position";
import { logActivity } from "./helpers";
import { executeLiveExit } from "./live-execution";
import type { EntryContext } from "./entry";
import type { LlmTraderEvaluation } from "./llm-trader";

/** Move stop-loss to break-even when the LLM signals it AND we're at
 *  ≥+1R favorable. Defensive against LLM hallucinating P&L: the +1R gate
 *  is verified against actual entry/SL math, not the LLM's claim.
 *
 *  Returns `{ opened: 0 }` on every path (this never opens a position).
 *  Caller pattern: `if (decision.decision === "move_be") return executeLlmMoveBe(...)`.
 */
export async function executeLlmMoveBe(
  ctx: EntryContext,
  currentPosition: PaperPosition | null,
  currentPrice: number,
  decision: { confidence: number; reasoning: string },
  evaluation: LlmTraderEvaluation
): Promise<{ opened: number }> {
  const { supabase, userId, algo, ticker } = ctx;
  if (!currentPosition) {
    await logMoveBeRejection(ctx, null, evaluation, decision, "LLM decision: move_be but no open position");
    return { opened: 0 };
  }
  const entryPrice = Number(currentPosition.entry_price);
  const stopPrice = currentPosition.stop_loss_price ? Number(currentPosition.stop_loss_price) : null;
  if (!stopPrice) {
    await logMoveBeRejection(ctx, currentPosition, evaluation, decision, "LLM decision: move_be but no stop_loss_price set on position");
    return { opened: 0 };
  }
  // Use initial SL distance for the +1R gate so a second move_be on the
  // same trade doesn't divide by zero. Falls back to current SL for
  // legacy rows pre-migration 00032.
  const initialStop = currentPosition.initial_stop_loss_price ?? stopPrice;
  const slDistance = Math.abs(entryPrice - Number(initialStop));
  if (slDistance <= 0) {
    await logMoveBeRejection(ctx, currentPosition, evaluation, decision, "LLM decision: move_be skipped — zero initial SL distance (legacy BE'd row)");
    return { opened: 0 };
  }
  const currentPnlR =
    currentPosition.side === "long"
      ? (currentPrice - entryPrice) / slDistance
      : (entryPrice - currentPrice) / slDistance;
  if (currentPnlR < 1.0) {
    await logMoveBeRejection(ctx, currentPosition, evaluation, decision, `LLM decision: move_be but only +${currentPnlR.toFixed(2)}R favorable (need +1R)`);
    return { opened: 0 };
  }
  // Update SL to entry price. Broker's wider SL stays as safety net.
  await supabase
    .from("paper_positions")
    .update({ stop_loss_price: entryPrice })
    .eq("id", currentPosition.id);
  await logActivity(supabase, userId, {
    algorithm_id: algo.id,
    position_id: currentPosition.id,
    event_type: "signal_no_action",
    ticker,
    details: {
      reason: `LLM moved SL to break-even at +${currentPnlR.toFixed(2)}R`,
      source: "llm_trader",
      regime: evaluation.regime,
      action: "move_sl_to_be",
      old_stop_loss: stopPrice,
      new_stop_loss: entryPrice,
      current_pnl_r: currentPnlR,
      confidence: decision.confidence,
      llm_reasoning: decision.reasoning,
    },
  });
  return { opened: 0 };
}

/** Audit log helper for the various reject paths in executeLlmMoveBe.
 *  All share the same `signal_no_action` shape + llm_trader source. */
async function logMoveBeRejection(
  ctx: EntryContext,
  position: PaperPosition | null,
  evaluation: LlmTraderEvaluation,
  decision: { confidence: number; reasoning: string },
  reason: string
): Promise<void> {
  await logActivity(ctx.supabase, ctx.userId, {
    algorithm_id: ctx.algo.id,
    ...(position ? { position_id: position.id } : {}),
    event_type: "signal_no_action",
    ticker: ctx.ticker,
    details: {
      reason,
      source: "llm_trader",
      regime: evaluation.regime,
      confidence: decision.confidence,
      llm_reasoning: decision.reasoning,
    },
  });
}

/** Close the position at this bar's close on LLM-signal exit. Mirrors
 *  backtest behaviour — the LLM's "exit" decision is a regime-flip /
 *  thesis-breakdown signal that's the algo's edge for catching turns
 *  before SL fires. Without this branch, "exit" was a logged no-op and
 *  positions ran to SL/TP, costing an estimated $1-3K per 8mo window on
 *  the regime-flip cohort.
 *
 *  Returns `{ opened: 0 }` on every path (this only closes, never opens).
 */
export async function executeLlmExit(
  ctx: EntryContext,
  currentPosition: PaperPosition | null,
  currentPrice: number,
  decision: { confidence: number; reasoning: string },
  evaluation: LlmTraderEvaluation
): Promise<{ opened: number }> {
  const { supabase, userId, algo, ticker, brokerCtx } = ctx;

  if (!currentPosition) {
    // LLM said exit but we're flat — no-op + log. Shouldn't happen
    // (the prompt instructs "exit only valid when in a position")
    // but defensive.
    await logActivity(supabase, userId, {
      algorithm_id: algo.id,
      event_type: "signal_no_action",
      ticker,
      details: {
        reason: "LLM decision: exit but no open position",
        source: "llm_trader",
        regime: evaluation.regime,
        confidence: decision.confidence,
        llm_reasoning: decision.reasoning,
      },
    });
    return { opened: 0 };
  }
  const exitPrice = currentPrice;
  const realizedPnl = pnlInUsd(
    ticker,
    currentPosition.side as "long" | "short",
    Number(currentPosition.entry_price),
    exitPrice,
    Number(currentPosition.quantity)
  );
  await supabase
    .from("paper_positions")
    .update({
      current_price: exitPrice,
      exit_price: exitPrice,
      unrealized_pnl: 0,
      realized_pnl: realizedPnl,
      exit_reason: "exit_signal",
      status: "closed",
      closed_at: new Date().toISOString(),
    })
    .eq("id", currentPosition.id);
  if (brokerCtx) {
    await executeLiveExit({
      supabase,
      userId,
      algorithmId: algo.id,
      paperPositionId: currentPosition.id,
      ticker,
      brokerPositionId: currentPosition.broker_position_id ?? null,
      closePrice: exitPrice,
      ctx: brokerCtx,
    });
  }
  await logActivity(supabase, userId, {
    algorithm_id: algo.id,
    position_id: currentPosition.id,
    event_type: "position_closed",
    ticker,
    details: {
      reason: "LLM decision: exit",
      source: "llm_trader",
      regime: evaluation.regime,
      exit_price: exitPrice,
      realized_pnl: realizedPnl,
      exit_reason: "exit_signal",
      confidence: decision.confidence,
      llm_reasoning: decision.reasoning,
    },
  });
  return { opened: 0 };
}

// CB.H1 pass 20 (2026-06-22): `executeLlmEnter` moved to
// `./entry-llm-enter.ts`. Re-exported for back-compat with
// entry-llm-trader.ts which imports it from this module.
export { executeLlmEnter } from "./entry-llm-enter";
