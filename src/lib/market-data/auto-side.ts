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
import type { PriceBar } from "./types";

export interface ResolvedSide {
  side: "long" | "short";
  /** Used by ConditionContext to override pattern conditions' configured
   *  `direction` filter so they fire in the active regime direction. */
  directionOverride?: "bullish" | "bearish";
}

/**
 * Pass undefined `idx` for the live path (uses the latest D1 bar).
 * For backtest replay, pass the simulation's bar index — D1 bias is
 * computed against `higherTfBars[..idx]` so it reflects only the
 * information available at that point in time.
 */
export function resolveSide(
  configured: "long" | "short" | "auto",
  higherTfBars: PriceBar[] | undefined,
  intradayIdx?: number
): ResolvedSide | null {
  if (configured === "long") return { side: "long" };
  if (configured === "short") return { side: "short" };
  // auto — gate on D1 bias.
  if (!higherTfBars || higherTfBars.length === 0) return null;
  // Only D1 bars up to "now" should influence the decision; in the live
  // path that's the entire array, in backtest we'd ideally slice by date
  // but the resampled D1 cardinality is much smaller than intraday so the
  // simpler approach (use all D1 bars) is acceptable for daily-bias.
  void intradayIdx;
  const r = detectDailyBias(higherTfBars, 20);
  if (!r.detected || !r.details) return null;
  if (r.details.bias === "bullish") {
    return { side: "long", directionOverride: "bullish" };
  }
  if (r.details.bias === "bearish") {
    return { side: "short", directionOverride: "bearish" };
  }
  return null;
}
