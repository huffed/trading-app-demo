/**
 * Resolve the active trade side for an algorithm given its configured
 * `rules.side`. Fixed long/short pass through. "auto" mode reads the
 * higher-timeframe bias on the current bar and returns whichever
 * direction is decisively trending — null when neutral so the caller
 * can skip the entry rather than guess.
 *
 * Used by both the backtest engine (per-bar) and the live scan engine
 * (once per scan, against the current bar) so the same regime gate
 * applies in replay and in production.
 */
import { detectDailyBias } from "@/lib/patterns";
import { lastIdxAtOrBefore } from "./market-state";
import type { PriceBar } from "./types";

export interface ResolvedSide {
  side: "long" | "short";
  /** Used by ConditionContext to override pattern conditions' configured
   *  `direction` filter so they fire in the active regime direction. */
  directionOverride?: "bullish" | "bearish";
}

/**
 * Live path passes `currentDate=undefined` (higherTfBars is already
 * "now"). Backtest replay MUST pass the primary bar's date so we slice
 * higherTfBars to bars dated ≤ currentDate before computing D1 bias —
 * otherwise detectDailyBias reads "today's bias" (look-ahead), the
 * same bug fixed at evaluate.ts:143 for the pattern-condition path.
 * Previously this was thought "acceptable for daily-bias" because D1
 * cardinality is small, but that's still N days of look-ahead for an
 * algo making decisions on historical bars — real bug.
 */
export function resolveSide(
  configured: "long" | "short" | "auto",
  higherTfBars: PriceBar[] | undefined,
  currentDate?: string
): ResolvedSide | null {
  if (configured === "long") return { side: "long" };
  if (configured === "short") return { side: "short" };
  // auto — gate on D1 bias.
  if (!higherTfBars || higherTfBars.length === 0) return null;
  let alignedBars = higherTfBars;
  if (currentDate) {
    const dIdx = lastIdxAtOrBefore(higherTfBars, currentDate);
    if (dIdx < 0) return null;
    alignedBars = higherTfBars.slice(0, dIdx + 1);
  }
  const r = detectDailyBias(alignedBars, 20);
  if (!r.detected || !r.details) return null;
  if (r.details.bias === "bullish") {
    return { side: "long", directionOverride: "bullish" };
  }
  if (r.details.bias === "bearish") {
    return { side: "short", directionOverride: "bearish" };
  }
  return null;
}
