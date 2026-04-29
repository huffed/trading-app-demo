/**
 * Mixed condition evaluator — dispatches between technical (indicator math
 * over price series) and pattern (chart-pattern detection from raw bars).
 *
 * Multi-timeframe routing: every condition has a `timeframe` field. When
 * the caller supplies `byTimeframe` bundles (one per non-primary TF), the
 * evaluator routes each condition to bars + cache + bar index belonging
 * to its declared timeframe. Conditions on the primary TF use the existing
 * primary fields. This is what lets a single algorithm hunt across 15m +
 * 1h + 4h simultaneously, like a discretionary trader scanning charts.
 *
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

/** Per-timeframe state. Each non-primary timeframe gets its own bars +
 *  closes + cache + aligned bar index ("now" in that timeframe). */
export interface BarsBundle {
  bars: PriceBar[];
  closes: number[];
  cache: Cache;
  i: number;
}

/** Bundled state for checkConditions. `bars` + `closes` + `cache` + `i`
 *  describe the PRIMARY timeframe (the one the algorithm is configured
 *  for). `byTimeframe` carries non-primary timeframes a condition can
 *  reference via its own `timeframe` field. */
export interface ConditionContext {
  cache: Cache;
  closes: number[];
  bars: PriceBar[];
  i: number;
  /** Resampled D1 bars for daily_bias-style higher-timeframe filters.
   *  Independent of byTimeframe so back-compat callers still work. */
  higherTfBars?: PriceBar[];
  directionOverride?: "bullish" | "bearish";
  /** Non-primary timeframes the algorithm hunts on. Map keys are
   *  normalized timeframe strings ("15m", "4h", "1d", etc.). */
  byTimeframe?: Map<string, BarsBundle>;
  /** Timeframe label of the primary bundle. When a condition's
   *  `timeframe` matches this, no map lookup happens. */
  primaryTimeframe?: string;
}

type TechnicalEvaluator = (
  cond: TechnicalCondition,
  bundle: BarsBundle
) => boolean;

function bundleFor(cond: EvaluableCondition, ctx: ConditionContext): BarsBundle {
  const ct = cond.timeframe?.toLowerCase();
  const pt = ctx.primaryTimeframe?.toLowerCase();
  if (!ct || !pt || ct === pt) {
    return { bars: ctx.bars, closes: ctx.closes, cache: ctx.cache, i: ctx.i };
  }
  return (
    ctx.byTimeframe?.get(ct) ?? {
      bars: ctx.bars,
      closes: ctx.closes,
      cache: ctx.cache,
      i: ctx.i,
    }
  );
}

/**
 * Walk the condition list and count how many fire. Used both by the
 * boolean `checkConditions` (logic combinator) and by conviction-scaled
 * position sizing which needs to know the *exact* alignment count, not
 * just whether the threshold was met. Single source of truth so a future
 * change to the per-condition evaluation never silently desyncs the two
 * paths.
 */
export function countConditionsMet(
  conditions: EvaluableCondition[],
  ctx: ConditionContext,
  evaluateTechnical: TechnicalEvaluator
): { met: number; total: number } {
  let met = 0;
  for (const c of conditions) {
    const bundle = bundleFor(c, ctx);
    if (isTechnicalCondition(c)) {
      if (evaluateTechnical(c, bundle)) met++;
    } else if (isPatternCondition(c)) {
      // daily_bias still uses higherTfBars (resampled D1) regardless of
      // the per-condition routing, since it's the canonical "trend filter".
      if (
        evaluatePatternCondition(
          c,
          bundle.bars,
          bundle.i,
          ctx.higherTfBars,
          ctx.directionOverride
        )
      ) {
        met++;
      }
    }
  }
  return { met, total: conditions.length };
}

export function checkConditions(
  conditions: EvaluableCondition[],
  ctx: ConditionContext,
  evaluateTechnical: TechnicalEvaluator,
  logic: EntryLogic = "all"
): boolean {
  if (conditions.length === 0) return false;
  const { met, total } = countConditionsMet(conditions, ctx, evaluateTechnical);
  if (logic === "all") return met === total;
  if (logic === "any") return met > 0;
  return met >= logic.n;
}
