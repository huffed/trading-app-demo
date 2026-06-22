/**
 * Condition evaluation utilities — shared between live scan + backtest
 * paths. Extracted from `lib/market-data/backtest-engine.ts` in CB.C6
 * (2026-06-20) to break the live → backtest direct dependency. Before:
 * `scan/engine.ts` + `scan/entry.ts` + `market-data/portfolio-backtest.ts`
 * all imported from `backtest-engine.ts`, conceptually pulling backtest-
 * specific code into the live trading path. After: all three import from
 * this neutral module; `backtest-engine.ts` keeps only `runBacktest` +
 * `BacktestContext` and itself imports the utilities back from here for
 * use inside the simulation loop.
 *
 * What lives here (the "what does this condition evaluate to RIGHT NOW"
 * primitives — both live tick processing AND backtest bar iteration ask
 * the same question):
 *
 * - `checkConditions(...)` — boolean AND/OR/n_of_m verdict
 * - `countConditionsMet(...)` — `{met, total}` alignment count
 * - `evaluateConditionsDetailed(...)` — `{met, total, fired[]}` per-condition breakdown
 * - `countTimeframesAgreeing(...)` — `{firedTfs, totalTfs}` for tf-agreement conviction
 * - `convictionMultiplierForRules(...)` — dispatch helper for position sizing
 * - `normalize(...)` — legacy condition normaliser (untyped → "technical")
 * - `collectOtherTimeframes(...)` — non-primary TF set for multi-TF context map
 *
 * What's NOT here (lives in backtest-engine.ts because it's backtest-specific):
 * - `runBacktest()` — the simulation loop itself
 * - `BacktestContext` — input bundle for runBacktest
 */
import {
  convictionMultiplier,
  convictionMultiplierByTfAgreement,
} from "@/lib/algorithm/conviction-sizing";
import {
  checkConditions as checkMixedConditions,
  countConditionsMet as countMixedConditionsMet,
  countTimeframesAgreeing as countMixedTfAgreement,
  evaluateConditionsDetailed as evaluateMixedConditionsDetailed,
  type ConditionContext,
  type EvaluableCondition,
} from "@/lib/market-data/condition-evaluator";
import { getValues, type Cache } from "@/lib/market-data/indicator-registry";
import { evaluateTechnical } from "@/lib/market-data/technical-evaluator";
import {
  type AlgorithmRules,
  type EntryCondition,
  type ExitCondition,
  type TechnicalCondition,
} from "@/types/algorithm";

// Re-export the bag-of-primitives types so consumers don't need to know
// they were originally defined in lib/market-data/condition-evaluator.ts.
// (backtest-engine.ts had the same re-exports before CB.C6.)
export type { Cache, ConditionContext, EvaluableCondition };

/** Evaluate the (entry OR exit) condition set against the current bar
 *  context. Returns true when the logic (AND / OR / n_of_m) is satisfied.
 *  Internally injects the technical-condition evaluator so pattern + tech
 *  conditions share one dispatch. */
export function checkConditions(
  conditions: EvaluableCondition[],
  ctx: ConditionContext,
  logic?: AlgorithmRules["entry_logic"]
): boolean {
  return checkMixedConditions(
    conditions,
    ctx,
    (c, c2) =>
      evaluateTechnical(c, getValues(c.indicator, c2.cache, c2.closes), c2.closes, c2.cache, c2.i),
    logic
  );
}

/** Same evaluation as `checkConditions` but returns the alignment count
 *  (`met` / `total`) instead of just the boolean decision. Used by
 *  conviction-scaled position sizing — more conditions firing above the
 *  n_of_m threshold = larger position. Single source of truth shared
 *  with the live engine via the underlying evaluator. */
export function countConditionsMet(
  conditions: EvaluableCondition[],
  ctx: ConditionContext
): { met: number; total: number } {
  return countMixedConditionsMet(conditions, ctx, (c, c2) =>
    evaluateTechnical(c, getValues(c.indicator, c2.cache, c2.closes), c2.closes, c2.cache, c2.i)
  );
}

/** Same as countConditionsMet but exposes the per-condition fired array
 *  so the scan engine can log a structured breakdown into the
 *  signal_detected event. */
export function evaluateConditionsDetailed(
  conditions: EvaluableCondition[],
  ctx: ConditionContext
): { met: number; total: number; fired: boolean[] } {
  return evaluateMixedConditionsDetailed(conditions, ctx, (c, c2) =>
    evaluateTechnical(c, getValues(c.indicator, c2.cache, c2.closes), c2.closes, c2.cache, c2.i)
  );
}

/** Count distinct timeframes with ≥1 firing condition. Wraps the
 *  underlying counter and injects the technical evaluator. Used for
 *  TF-agreement conviction sizing on multi-TF templates. */
export function countTimeframesAgreeing(
  conditions: EvaluableCondition[],
  ctx: ConditionContext
): { firedTfs: number; totalTfs: number } {
  return countMixedTfAgreement(conditions, ctx, (c, c2) =>
    evaluateTechnical(c, getValues(c.indicator, c2.cache, c2.closes), c2.closes, c2.cache, c2.i)
  );
}

/** Dispatch the right conviction multiplier based on the rule's
 *  `conviction_metric`. Returns 1 (flat) for non-conviction sizing.
 *
 *  Centralised so the three sizing call sites (single-ticker backtest,
 *  portfolio backtest, live scan) can never disagree on which signal
 *  drives conviction — a desync there silently changes live behaviour. */
export function convictionMultiplierForRules(
  rules: AlgorithmRules,
  conditions: EvaluableCondition[],
  ctx: ConditionContext
): number {
  const sizing = rules.position_sizing;
  if (sizing.type !== "conviction_scaled") return 1;
  if (sizing.conviction_metric === "tf_agreement") {
    const { firedTfs, totalTfs } = countTimeframesAgreeing(conditions, ctx);
    return convictionMultiplierByTfAgreement(firedTfs, totalTfs, sizing.max_multiplier);
  }
  const { met, total } = countConditionsMet(conditions, ctx);
  return convictionMultiplier(rules.entry_logic, met, total, sizing.max_multiplier);
}

/** Legacy condition normaliser — fills in `type: "technical"` on
 *  pre-discriminated-union records. The Zod schema's preprocess hook
 *  catches this at load time too; this is the engine-side safety net. */
export function normalize(
  conditions: (EntryCondition | ExitCondition)[]
): (EntryCondition | ExitCondition)[] {
  return conditions.map((c) => {
    if (!c.type && "indicator" in c) {
      return Object.assign({}, c, { type: "technical" as const }) as TechnicalCondition;
    }
    return c;
  });
}

/** Pull every distinct condition timeframe that ISN'T the primary one,
 *  lowercased + deduped. Used to size the multi-timeframe context map.
 *  Accepts any condition shape with an optional timeframe field — works
 *  on EvaluableCondition arrays AND on the broader EntryCondition union
 *  (sentiment included), since sentiment also has a timeframe field. */
export function collectOtherTimeframes(
  entry: { timeframe?: string }[],
  exit: { timeframe?: string }[],
  primaryTf: string
): string[] {
  const set = new Set<string>();
  for (const c of [...entry, ...exit]) {
    if (!c.timeframe) continue;
    const tf = c.timeframe.toLowerCase();
    if (tf !== primaryTf) set.add(tf);
  }
  return Array.from(set);
}
