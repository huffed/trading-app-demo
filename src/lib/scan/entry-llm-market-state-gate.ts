/**
 * Market-state gate for the LLM-trader entry path. The regime-library
 * dormancy mechanism — library algos sleep this tick (zero LLM spend)
 * when the market state doesn't match the rule's configured pattern.
 *
 * Flat-only and per-algo via `rules.market_state_gate` — in-position
 * management is never muzzled (2026-05-11 lesson: ATR gate skipped 3
 * consecutive LLM calls while a position ran to a $365 SL) and there
 * is no global gate list (feedback_gate_doing_too_much). Specialists
 * fail closed on unreadable state.
 *
 * Two log emissions per evaluation:
 *  1. Shadow log — fires whenever `verdict.shadow_block_reason` is set,
 *     even if the gate ultimately allows. Pure observability for
 *     calibration (operator can see "this gate WOULD have blocked under
 *     a stricter config").
 *  2. Block log + early-return — fires when `!verdict.allowed`.
 *
 * Extracted from `entry-llm-trader.ts` in CB.H1 pass 3 (2026-06-22).
 */
import {
  checkMarketStateGateConfig,
  computePositionInRangePct,
  gateConfigModeLabel,
  type GateContext,
} from "@/lib/algorithm/market-state-gate";
import type { MarketState } from "@/lib/market-data/market-state";
import type { PaperPosition } from "@/types/position";
import { logActivity } from "./helpers";
import type { EntryContext } from "./entry";

export interface MarketStateGateResult {
  blocked: boolean;
}

export async function checkLlmMarketStateGate(
  ctx: EntryContext,
  marketState: MarketState | null,
  currentPrice: number,
  currentPosition: PaperPosition | null
): Promise<MarketStateGateResult> {
  const { supabase, userId, algo, ticker, bars } = ctx;
  const gateConfig = algo.rules.market_state_gate;

  // Gate only fires when flat AND the algo has a market_state_gate rule
  // configured. Ungated algos + in-position management both fall through.
  if (currentPosition || !gateConfig) return { blocked: false };

  const gateCtx: GateContext = {
    entryHourUtc: new Date().getUTCHours(),
    positionInRangePct: computePositionInRangePct(bars, currentPrice),
  };
  const verdict = checkMarketStateGateConfig(gateConfig, marketState, gateCtx);
  const gateMode = gateConfigModeLabel(gateConfig);

  // Shadow log: fires even when the gate ALLOWS — pure observability
  // so operator can see "under a stricter config, this would have blocked."
  if (verdict.shadow_block_reason) {
    await logActivity(supabase, userId, {
      algorithm_id: algo.id,
      event_type: "signal_no_action",
      ticker,
      details: {
        reason: "market_state_gate_shadow",
        source: "llm_trader",
        gate_mode: gateMode,
        would_block: verdict.shadow_block_reason,
        market_state: marketState,
        entry_hour_utc: gateCtx.entryHourUtc,
        position_in_range_pct: gateCtx.positionInRangePct,
      },
    });
  }

  if (!verdict.allowed) {
    await logActivity(supabase, userId, {
      algorithm_id: algo.id,
      event_type: "signal_no_action",
      ticker,
      details: {
        reason: "market_state_gate",
        source: "llm_trader",
        gate_mode: gateMode,
        verdict: verdict.reason,
        market_state: marketState,
        entry_hour_utc: gateCtx.entryHourUtc,
        position_in_range_pct: gateCtx.positionInRangePct,
      },
    });
    return { blocked: true };
  }

  return { blocked: false };
}
