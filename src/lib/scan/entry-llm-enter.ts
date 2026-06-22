/**
 * LLM-trader enter-side dispatch — runs the post-LLM enter-gate ladder,
 * logs `signal_detected`, opens the position with the LLM-determined
 * side + adaptive TP context, and links the decision audit row to the
 * resulting paper position. Extracted from
 * `entry-llm-position-actions.ts` on 2026-06-22 (CB.H1 pass 20) to keep
 * the in-position actions (move_be, exit) separate from the entry
 * branch.
 */
import type { AtrLiquidityResult } from "@/lib/algorithm/intraday-atr-gate";
import {
  dailyAtrFromBars,
  type AdaptiveTpContext,
} from "@/lib/algorithm/structural-sl";
import type { MarketState } from "@/lib/market-data/market-state";
import type { PriceBar } from "@/lib/market-data/types";
import type { PositionEvent } from "@/types/position";
import { checkLlmEnterGates } from "./entry-llm-enter-gates";
import { openPosition, type AlgoContext } from "./entry-open";
import { logActivity } from "./helpers";
import { linkLlmDecisionToPosition } from "./llm-trader-audit";
import type { EntryContext } from "./entry";
import type { LlmTraderDecision, LlmTraderEvaluation } from "./llm-trader";

export async function executeLlmEnter(
  ctx: EntryContext,
  decision: LlmTraderDecision,
  evaluation: LlmTraderEvaluation,
  decisionId: string | null,
  marketState: MarketState | null,
  liquidity: AtrLiquidityResult,
  dailyBars: PriceBar[] | null | undefined
): Promise<{ opened: number; openEvent?: PositionEvent }> {
  const { supabase, userId, algo, ticker, bars, closes, livePrice, allOpenPositions, brokerCtx } = ctx;
  const currentPrice = livePrice ?? closes[closes.length - 1];
  const llmSide: "long" | "short" =
    decision.decision === "enter_long" ? "long" : "short";

  const enterGateResult = await checkLlmEnterGates(ctx, llmSide, decision, evaluation);
  if (enterGateResult.blocked) return { opened: 0 };

  await logActivity(supabase, userId, {
    algorithm_id: algo.id,
    event_type: "signal_detected",
    ticker,
    details: {
      source: "llm_trader",
      regime: evaluation.regime,
      direction: llmSide,
      confidence: decision.confidence,
      llm_reasoning: decision.reasoning,
      atr_current: liquidity.atr_current,
      atr_threshold: liquidity.atr_threshold,
      market_state: marketState ?? undefined,
    },
  });

  // Override rules.side so openPosition's side resolution picks up the
  // LLM's call. Adaptive TP context tightens RR/percentage in chop +
  // caps absolute distance at a reachable fraction of daily ATR.
  const algoForOpen: AlgoContext = {
    ...algo,
    rules: { ...algo.rules, side: llmSide },
  };
  const adaptiveTpCtx: AdaptiveTpContext = {
    regime: evaluation.regime,
    dailyAtr: dailyBars && dailyBars.length > 0 ? dailyAtrFromBars(dailyBars) : 0,
  };
  const opened = await openPosition({
    supabase,
    userId,
    algo: algoForOpen,
    ticker,
    currentPrice,
    conditions: [],
    sentimentResult: undefined,
    allOpenPositions,
    brokerCtx: brokerCtx ?? null,
    convictionMult: 1,
    bars,
    adaptiveTpCtx,
    cohortFromCaller: {
      regime: evaluation.regime !== "n/a" ? evaluation.regime : undefined,
      ...(marketState ? { market_state: marketState } : {}),
    },
    dailyBarsForLevels: dailyBars,
  });
  if (decisionId && opened.paperPositionId) {
    await linkLlmDecisionToPosition(supabase, decisionId, opened.paperPositionId);
  }
  return opened;
}
