/**
 * LLM-trader entry path — siblings of evaluateEntry. Replaces the
 * pattern-detect + threshold pipeline (entry_conditions check + sentiment)
 * with an LLM call that determines direction (long/short/hold/exit)
 * from rich market context.
 *
 * Defensive pre-gates that still apply on top: intraday ATR liquidity,
 * news veto, R-aware consec-loss halt, time-of-day filter (if enabled),
 * FTMO consistency halt (live), broker spread gate (live), position-size
 * sanity gate (in openPosition).
 *
 * Strategy-specific filters skipped: dxy_filter, regime_filter, adx_filter
 * — the LLM already considers DXY / regime / trend in its prompt context,
 * applying the gates would be double-counting. The user can re-enable
 * via rules if they want stricter behaviour.
 *
 * Extracted from entry.ts in CB.C1 (2026-06-20). All gate logic preserved
 * byte-for-byte; only the file boundary moved.
 */
import { checkBarStaleness } from "@/lib/algorithm/bar-staleness-gate";
import { checkAtrLiquidity } from "@/lib/algorithm/intraday-atr-gate";
import type { MarketState } from "@/lib/market-data/market-state";
import type { PriceBar } from "@/lib/market-data/types";
import type { PaperPosition, PositionEvent } from "@/types/position";
import { computeLiveMarketState } from "./entry-gates";
import { buildLlmTraderCtx } from "./entry-llm-context";
import { checkDefensiveLlmGates } from "./entry-llm-defensive-gates";
import { checkLlmMarketStateGate } from "./entry-llm-market-state-gate";
import {
  executeLlmEnter,
  executeLlmExit,
  executeLlmMoveBe,
} from "./entry-llm-position-actions";
import { logActivity } from "./helpers";
import { evaluateLlmTrader, isBarCloseScan } from "./llm-trader";
import { recordLlmDecision } from "./llm-trader-audit";
import type { EntryContext } from "./entry";

export async function evaluateLlmTraderEntry(
  ctx: EntryContext
): Promise<{ opened: number; openEvent?: PositionEvent }> {
  const { supabase, userId, algo, ticker, bars, closes, allOpenPositions, livePrice, dailyBars, dxyBars, force = false } = ctx;
  const rules = algo.rules;
  const llmConfig = rules.llm_trader;
  if (!llmConfig?.enabled) return { opened: 0 };
  const currentPrice = livePrice ?? closes[closes.length - 1];

  // Bar-close + bar-staleness gates (size-cap extraction). force=true
  // bypasses bar-close only; staleness still applies.
  if (await checkBarTimingGates({ supabase, userId, algo, ticker, bars, force, timeframe: rules.timeframe })) {
    return { opened: 0 };
  }

  // Load the position FIRST so the entry-side gates below can be
  // conditionally skipped when a position is open. Incident 2026-05-11:
  // 4h XAU/USD long hit a $365 SL after the ATR gate skipped 3 consecutive
  // LLM calls (post-weekend dead-vol). Fix: gates only block when flat.
  const currentPosition =
    allOpenPositions.find((p) => p.algorithm_id === algo.id && p.ticker === ticker) ?? null;
  const liquidity = checkAtrLiquidity(bars, bars.length - 1);
  if (!currentPosition) {
    const gateResult = await checkDefensiveLlmGates(ctx, liquidity);
    if (gateResult.blocked) return { opened: 0 };
  }

  // ---- Market state (computed once per evaluation) ----
  // Leading-indicator states (study PR #188). Computed BEFORE the LLM
  // call so (a) a market_state_gate refusal costs $0 in LLM spend and
  // (b) the same read feeds the decision audit + entry cohort shadow
  // logging below.
  const marketState: MarketState | null = await computeLiveMarketState(
    ticker,
    rules.timeframe,
    bars,
    dailyBars,
    dxyBars
  );

  // CB.H1 pass 3 (2026-06-22): market-state gate extracted to
  // entry-llm-market-state-gate.ts. Flat-only + per-algo + fires shadow
  // log + block log; see new file's docstring for the design rationale.
  const msGateResult = await checkLlmMarketStateGate(
    ctx,
    marketState,
    currentPrice,
    currentPosition
  );
  if (msGateResult.blocked) return { opened: 0 };

  // CB.H1 pass 4: buildLlmTraderCtx extraction. LLM call returns null on
  // exhausted retry → signal_no_action + return.
  const traderCtx = await buildLlmTraderCtx(ctx, currentPosition);
  const evaluation = await evaluateLlmTrader(llmConfig, traderCtx);
  const decision = evaluation.decision;
  if (!decision) {
    await logLlmCallFailure(supabase, userId, algo.id, ticker, evaluation.regime);
    return { opened: 0 };
  }

  // Audit-log the decision (best-effort; never blocks trade flow).
  const hadPosition: "flat" | "long" | "short" =
    currentPosition ? (currentPosition.side as "long" | "short") : "flat";
  const decisionId = await recordLlmDecision(supabase, {
    algorithmId: algo.id,
    userId,
    barDate: traderCtx.currentTimestamp,
    evaluation,
    hadPosition,
    source: "live",
    contextComponents: marketState ? { market_state: marketState } : undefined,
  });

  // Hold: always log (even when capped) so operator has visibility of
  // every in-trade management decision. 2026-05-12 incident: silent drop
  // happened when in trade + capped (cap path only logs for enter_*).
  if (decision.decision === "hold") {
    await logLlmHold(supabase, userId, algo.id, ticker, currentPosition, decision, evaluation, hadPosition);
    return { opened: 0 };
  }

  // CB.H1 (2026-06-22): move_be + exit branches extracted to
  // entry-llm-position-actions.ts. Both are terminal in-trade actions
  // (no new position opened) — the orchestrator just delegates.
  if (decision.decision === "move_be") {
    return executeLlmMoveBe(ctx, currentPosition, currentPrice, decision, evaluation);
  }
  if (decision.decision === "exit") {
    return executeLlmExit(ctx, currentPosition, currentPrice, decision, evaluation);
  }

  // CB.H1 pass 9 (2026-06-22): enter_long/enter_short branch extracted
  // to entry-llm-position-actions.ts (including the post-LLM enter-gate
  // ladder + signal_detected log + openPosition + decision link-back).
  return executeLlmEnter(ctx, decision, evaluation, decisionId, marketState, liquidity, dailyBars);
}

/** Log signal_no_action when the LLM call returned null after retry. */
async function logLlmCallFailure(
  supabase: EntryContext["supabase"],
  userId: string,
  algoId: string,
  ticker: string,
  regime: import("./llm-trader").Regime
): Promise<void> {
  await logActivity(supabase, userId, {
    algorithm_id: algoId,
    event_type: "signal_no_action",
    ticker,
    details: {
      reason: "LLM call failed (after retry)",
      source: "llm_trader",
      regime,
    },
  });
}

/** Log signal_no_action for "hold" decisions. Surfaces every in-trade
 *  management decision so the operator can see what the LLM saw. */
async function logLlmHold(
  supabase: EntryContext["supabase"],
  userId: string,
  algoId: string,
  ticker: string,
  currentPosition: PaperPosition | null,
  decision: import("./llm-trader").LlmTraderDecision,
  evaluation: import("./llm-trader").LlmTraderEvaluation,
  hadPosition: "flat" | "long" | "short"
): Promise<void> {
  await logActivity(supabase, userId, {
    algorithm_id: algoId,
    ...(currentPosition ? { position_id: currentPosition.id } : {}),
    event_type: "signal_no_action",
    ticker,
    details: {
      reason: "LLM decision: hold",
      source: "llm_trader",
      regime: evaluation.regime,
      confidence: decision.confidence,
      llm_reasoning: decision.reasoning,
      had_position: hadPosition,
    },
  });
}

interface BarTimingArgs {
  supabase: EntryContext["supabase"];
  userId: string;
  algo: EntryContext["algo"];
  ticker: string;
  bars: PriceBar[];
  force: boolean;
  timeframe: string;
}

/** Bar-close throttle + bar-staleness gate. Returns true when EITHER
 *  refuses the LLM call. Extracted from evaluateLlmTraderEntry for the
 *  size cap. Staleness incident 2026-05-12: 30m cache stale 60min →
 *  LLM analyzed bars dated 00:30 at 01:30 UTC, $25 below live. */
async function checkBarTimingGates(a: BarTimingArgs): Promise<boolean> {
  if (!a.force && !isBarCloseScan(a.timeframe)) return true;
  const lastBarDate = a.bars.length > 0 ? a.bars[a.bars.length - 1].date : null;
  const staleness = checkBarStaleness({ timeframe: a.timeframe, lastBarDate });
  if (staleness.block) {
    await logActivity(a.supabase, a.userId, {
      algorithm_id: a.algo.id,
      event_type: "signal_no_action",
      ticker: a.ticker,
      details: {
        reason: staleness.reason ?? "Bar-staleness gate triggered",
        source: "llm_trader",
        bar_age_minutes: staleness.bar_age_minutes,
        threshold_minutes: staleness.threshold_minutes,
        last_bar_date: staleness.last_bar_date,
      },
    });
    return true;
  }
  return false;
}
