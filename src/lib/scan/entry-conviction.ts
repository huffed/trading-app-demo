/**
 * Entry-side condition evaluation + conviction-multiplier dispatch.
 * Extracted from entry.ts in CB.C1 (2026-06-20) along with the condition-
 * snapshot serialiser. Imported by entry.ts (evaluateEntry orchestrator)
 * + entry-open.ts (openPosition uses snapshotCondition to flatten the
 * fired conditions into entry_reason.conditions_met).
 *
 * What's here:
 *  - `snapshotCondition` — flatten one TechnicalCondition | PatternCondition
 *    to a uniform JSONB-friendly shape
 *  - `EntryConditionResult` — gate verdict + alignment count + per-condition
 *    fired array, for sizing + logging
 *  - `checkEntryConditions` — the gate itself (technical + pattern conditions)
 *  - `pickConvictionMultiplier` — dispatch helper for conviction-scaled sizing
 */
import {
  convictionMultiplier,
  convictionMultiplierByTfAgreement,
} from "@/lib/algorithm/conviction-sizing";
import {
  collectOtherTimeframes,
  countTimeframesAgreeing,
  evaluateConditionsDetailed,
  normalize,
  type Cache,
} from "@/lib/conditions/evaluate";
import type { BarsBundle } from "@/lib/market-data/condition-evaluator";
import { resampleTo, resampleToDaily } from "@/lib/market-data/resample";
import type { PriceBar } from "@/lib/market-data/types";
import type {
  AlgorithmRules,
  PatternCondition,
  TechnicalCondition,
} from "@/types/algorithm";
import { logActivity } from "./helpers";
import type { SupabaseClient } from "@supabase/supabase-js";

// Re-export normalize so entry.ts can dispatch entry_conditions without
// pulling from @/lib/conditions/evaluate AND this module separately.
export { normalize };

/** Serialise a fired condition into the entry_reason.conditions_met blob.
 *  Different condition types carry different fields — caller iterates the
 *  mixed list and uses this to flatten each one to a uniform shape. */
export function snapshotCondition(c: TechnicalCondition | PatternCondition) {
  if (c.type === "technical") {
    return { type: c.type, indicator: c.indicator, operator: c.operator, value: c.value };
  }
  return {
    type: c.type,
    pattern: c.pattern,
    direction: c.direction,
    lookback: c.lookback,
    ma_period: c.ma_period,
  };
}

/**
 * Resolve the conviction multiplier from the gate result + rule. Same
 * dispatch logic as backtest-engine's `convictionMultiplierForRules`,
 * but operates on the already-computed counts so we don't re-evaluate
 * conditions a second time on the live path.
 */
export function pickConvictionMultiplier(
  rules: AlgorithmRules,
  gate: { met: number; total: number; firedTfs: number; totalTfs: number }
): number {
  const sizing = rules.position_sizing;
  if (sizing.type !== "conviction_scaled") return 1;
  if (sizing.conviction_metric === "tf_agreement") {
    return convictionMultiplierByTfAgreement(gate.firedTfs, gate.totalTfs, sizing.max_multiplier);
  }
  return convictionMultiplier(rules.entry_logic, gate.met, gate.total, sizing.max_multiplier);
}

export interface EntryConditionResult {
  /** True when the configured logic combinator (all / any / n_of_m) is
   *  satisfied. Caller uses this as the proceed/short-circuit gate. */
  pass: boolean;
  /** How many conditions actually fired. Threaded into conviction-scaled
   *  position sizing — more confluence above the n_of_m threshold = more
   *  size. Same numbers backtest and live use, so replay matches. */
  met: number;
  /** Total evaluable conditions (length of the technical + pattern list). */
  total: number;
  /** Per-condition fired/not-fired array, parallel to the input
   *  conditions list. Logged into signal_detected.details so the UI can
   *  show ✓/✗ per row. */
  fired: boolean[];
  /** Distinct timeframes with ≥1 firing condition. Used for the
   *  tf_agreement conviction metric on multi-TF templates. */
  firedTfs: number;
  /** Distinct timeframes referenced across the entry condition list. */
  totalTfs: number;
}

/** Evaluate the entry-condition gate (technical + pattern) and log a
 *  signal_no_action event when it fails. Returns the gate decision plus
 *  the alignment count, so the caller can drive conviction-based sizing
 *  without re-running the same evaluation. Sentiment is checked separately. */
export async function checkEntryConditions(
  supabase: SupabaseClient,
  userId: string,
  algoId: string,
  ticker: string,
  conditions: Array<TechnicalCondition | PatternCondition>,
  bars: PriceBar[],
  closes: number[],
  primaryTimeframe: string,
  logic: AlgorithmRules["entry_logic"],
  directionOverride?: "bullish" | "bearish",
  dailyBars?: PriceBar[] | null
): Promise<EntryConditionResult> {
  if (conditions.length === 0) {
    return { pass: true, met: 0, total: 0, fired: [], firedTfs: 0, totalTfs: 0 };
  }
  const cache: Cache = new Map();
  // Prefer the dedicated D1 series when supplied; fall back to resampling
  // the primary so older callers and missing-cache paths still work.
  const higherTfBars = dailyBars ?? resampleToDaily(bars);
  // Multi-timeframe routing: build aligned bundles for any non-primary
  // timeframe a condition references. Live uses the LATEST bar in each
  // resampled series — no alignment-by-date needed since "now" is now.
  const otherTfs = collectOtherTimeframes(conditions, [], primaryTimeframe.toLowerCase());
  let byTimeframe: Map<string, BarsBundle> | undefined;
  if (otherTfs.length > 0) {
    byTimeframe = new Map();
    for (const tf of otherTfs) {
      const tfBars = resampleTo(bars, tf);
      if (tfBars.length === 0) continue;
      byTimeframe.set(tf, {
        bars: tfBars,
        closes: tfBars.map((b) => b.close),
        cache: new Map(),
        i: tfBars.length - 1,
      });
    }
  }
  const ctx = {
    cache,
    closes,
    bars,
    i: closes.length - 1,
    higherTfBars,
    directionOverride,
    byTimeframe,
    primaryTimeframe: primaryTimeframe.toLowerCase(),
  };
  const { met, total, fired } = evaluateConditionsDetailed(conditions, ctx);
  const { firedTfs, totalTfs } = countTimeframesAgreeing(conditions, ctx);
  let pass: boolean;
  if (logic === "all") pass = met === total;
  else if (logic === "any") pass = met > 0;
  else pass = typeof logic === "object" && logic.type === "n_of_m" ? met >= logic.n : met === total;
  if (pass) return { pass: true, met, total, fired, firedTfs, totalTfs };
  await logActivity(supabase, userId, {
    algorithm_id: algoId,
    event_type: "signal_no_action",
    ticker,
    details: {
      reason: "Entry conditions not met",
      conditions_met: met,
      conditions_total: total,
      entry_logic: typeof logic === "object" ? `n_of_m(${logic.n})` : (logic ?? "all"),
      bar_date: bars[bars.length - 1]?.date,
      bar_close: closes[closes.length - 1],
      // Structured per-condition results (was a bare boolean[] — useless
      // in the evaluation-log UI without names). Shape: snapshotCondition
      // fields + timeframe + met.
      conditions_breakdown: conditions.map((c, idx) => ({
        ...snapshotCondition(c),
        timeframe: c.timeframe,
        met: fired[idx] ?? false,
      })),
    },
  });
  return { pass: false, met, total, fired, firedTfs, totalTfs };
}
