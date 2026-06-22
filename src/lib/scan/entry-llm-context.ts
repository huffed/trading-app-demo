/**
 * LLM-trader context construction. Builds the `LlmTraderContext` object
 * that `evaluateLlmTrader` consumes — Layer 3 in-context reflection
 * (recent outcomes) + multi-TF resampling for v5 / v5_15m / v2_mtf
 * prompts + the currentPosition snapshot.
 *
 * Extracted from `entry-llm-trader.ts` in CB.H1 pass 4 (2026-06-22).
 * The block was ~61 lines of pure context construction (no side effects
 * other than the `summariseRecentOutcomes` DB read for layer-3 reflection)
 * with a deeply-nested 4-branch ternary for the multi-TF pairings —
 * restructured here into a switch for readability + to drop the
 * `no-nested-ternary` warning surface.
 *
 * Multi-TF pairings (capability comes from `PROMPT_HAS_MTF_OVERRIDE`
 * registry, not a hardcoded list; the compiler forces new prompt versions
 * to declare it):
 *   30m primary → 1h + 4h (v5)
 *   15m primary → 30m + 1h (v5_15m)
 *   4h primary  → 1h only (v2_mtf — faster-pulse early-warning vs D1 lag)
 *   1h primary  → 4h only (single higher TF — override rule degraded)
 */
import { resampleTo } from "@/lib/market-data/resample";
import type { PaperPosition } from "@/types/position";
import { PROMPT_HAS_MTF_OVERRIDE, type PromptVersion } from "./llm-trader-prompts";
import { summariseRecentOutcomes } from "./llm-trader-reflection";
import type { EntryContext } from "./entry";
import type { LlmTraderContext } from "./llm-trader";

/** Resolve the higher-TF resampled bar pairings for the prompt. Returns
 *  `undefined` when the prompt doesn't declare multi-TF capability OR
 *  the primary timeframe is one the prompt-pairing table doesn't cover
 *  (caller silently omits the higherTfBars line in that case). */
function resolveHigherTfBars(
  promptVersion: PromptVersion | undefined,
  primaryTimeframe: string,
  bars: LlmTraderContext["bars"]
): LlmTraderContext["higherTfBars"] {
  const useMultiTf = promptVersion ? PROMPT_HAS_MTF_OVERRIDE[promptVersion] : false;
  if (!useMultiTf) return undefined;
  switch (primaryTimeframe) {
    case "30m":
      return [
        { tfLabel: "1h", bars: resampleTo(bars, "1h") },
        { tfLabel: "4h", bars: resampleTo(bars, "4h") },
      ];
    case "15m":
      return [
        { tfLabel: "30m", bars: resampleTo(bars, "30min") },
        { tfLabel: "1h", bars: resampleTo(bars, "1h") },
      ];
    case "4h":
      return [{ tfLabel: "1h", bars: resampleTo(bars, "1h") }];
    case "1h":
      return [{ tfLabel: "4h", bars: resampleTo(bars, "4h") }];
    default:
      return [];
  }
}

/** Snapshot the open-position fields the LLM context needs. Null safely
 *  represents "no open position" — caller's prompt will omit the line. */
function snapshotPosition(
  currentPosition: PaperPosition | null
): LlmTraderContext["position"] {
  if (!currentPosition) return null;
  return {
    side: currentPosition.side,
    entryPrice: Number(currentPosition.entry_price),
    entryDate: currentPosition.opened_at,
    stopPrice: currentPosition.stop_loss_price
      ? Number(currentPosition.stop_loss_price)
      : undefined,
    initialStopPrice: currentPosition.initial_stop_loss_price
      ? Number(currentPosition.initial_stop_loss_price)
      : undefined,
    targetPrice: currentPosition.take_profit_price
      ? Number(currentPosition.take_profit_price)
      : undefined,
  };
}

/** Build the LlmTraderContext for evaluateLlmTrader. One DB read for
 *  Layer-3 recent-outcomes reflection (silently omitted when <10 closed
 *  trades exist, so warm-up algos see nothing); rest is pure shape
 *  transformation. */
export async function buildLlmTraderCtx(
  ctx: EntryContext,
  currentPosition: PaperPosition | null
): Promise<LlmTraderContext> {
  const { supabase, algo, bars, dailyBars, dxyBars, intermarket } = ctx;
  const llmConfig = algo.rules.llm_trader;

  // Layer 3 in-context reflection — pass the algo's recent track record
  // into the LLM context. Self-gates: returns null when <10 closed trades
  // exist, so it's silently omitted during the warm-up phase. Activates
  // automatically as trades accumulate.
  const recentOutcomes = await summariseRecentOutcomes(supabase, algo.id);

  const higherTfBars = resolveHigherTfBars(
    llmConfig?.prompt_version,
    algo.rules.timeframe,
    bars
  );

  return {
    currentTimestamp: bars[bars.length - 1].date,
    bars,
    dailyBars: dailyBars ?? [],
    dxyBars,
    intermarket: intermarket ?? undefined,
    position: snapshotPosition(currentPosition),
    timeframe: algo.rules.timeframe,
    recentOutcomes,
    higherTfBars,
  };
}
