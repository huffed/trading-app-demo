/**
 * Mixed condition evaluator — dispatches between technical (indicator math
 * over price series) and pattern (chart-pattern detection from raw bars).
 * Sentiment conditions are filtered out before this function is called:
 * the backtest engine can't replay news history, and the scan engine
 * evaluates sentiment separately via its live signal pipeline.
 */
import { evaluatePatternCondition } from "@/lib/patterns";
import {
  isPatternCondition,
  isTechnicalCondition,
  type EntryLogic,
  type PatternCondition,
  type TechnicalCondition,
} from "@/types/algorithm";
import type { Cache } from "./indicator-registry";
import type { PriceBar } from "./types";

export type EvaluableCondition = TechnicalCondition | PatternCondition;

/** Bundled state for checkConditions. `bars` is required for pattern
 *  conditions; `higherTfBars` only by daily-bias filters. */
export interface ConditionContext {
  cache: Cache;
  closes: number[];
  bars: PriceBar[];
  i: number;
  higherTfBars?: PriceBar[];
}

type TechnicalEvaluator = (
  cond: TechnicalCondition,
  ctx: ConditionContext
) => boolean;

/**
 * Evaluate a mixed list of technical + pattern conditions against the
 * bar at `ctx.i` and combine results via the configured entry-logic.
 *
 * The technical evaluator is injected so this module doesn't import the
 * indicator registry directly — keeps the dependency graph clean and
 * the function unit-testable in isolation.
 */
export function checkConditions(
  conditions: EvaluableCondition[],
  ctx: ConditionContext,
  evaluateTechnical: TechnicalEvaluator,
  logic: EntryLogic = "all"
): boolean {
  if (conditions.length === 0) return false;
  let met = 0;
  for (const c of conditions) {
    if (isTechnicalCondition(c)) {
      if (evaluateTechnical(c, ctx)) met++;
    } else if (isPatternCondition(c)) {
      if (evaluatePatternCondition(c, ctx.bars, ctx.i, ctx.higherTfBars)) met++;
    }
  }
  if (logic === "all") return met === conditions.length;
  if (logic === "any") return met > 0;
  return met >= logic.n;
}
