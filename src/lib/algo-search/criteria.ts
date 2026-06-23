/**
 * Pre-registered acceptance criteria for the algorithm search (v2, post-hoc-locked 2026-06-23).
 *
 * Criteria are committed in `scripts/canonical/algo-search.spec.md` §4. This
 * module is the executable mirror — same floors, callable from anywhere
 * (driver, frontend, ad-hoc query). Used by:
 *   - src/lib/algo-search/state.ts (frontend /reports Search tab; adds cross-row pattern robustness)
 *   - any future scripts that need to re-evaluate persisted backtest_results
 *
 * NOTE: validate-algo.ts performs its own pre-reg check via `src/lib/stats/preregistration.ts`
 * — that path uses the LEGACY criteria set (WR + Bonferroni). This module is the
 * search-specific READ side that applies v2 criteria to persisted JSONB. The
 * two coexist: validate-algo's `promotion_eligible` flag is a separate signal
 * from `passesLayerA(results)` here.
 *
 * v2 vs v1 (see spec §4 for full rationale):
 *   - DROPPED min_win_rate_pct hard floor (kept as informational metadata)
 *   - DROPPED max_bonferroni_p_value (over-strict for portfolio applications;
 *     replaced by pattern-robustness check in state.ts + portfolio composer)
 *   - KEPT min_mean_r_ci_lower > 0 as PRIMARY statistical floor (strictly stronger
 *     guarantee than WR — the actual condition WR was approximating)
 *   - KEPT all DD / sample-size / OOS floors
 */

/** The 7 per-candidate hard criteria from spec §4 Layer A floors (v2).
 *  Pattern robustness (criterion 9) is cross-row and lives in state.ts. */
export interface SearchCriteria {
  min_total_return: number; // > 0
  max_static_dd_pct: number; // ≤ 10 (FTMO)
  max_daily_dd_pct: number; // ≤ 5 (FTMO)
  min_total_trades: number; // ≥ 30 (sample-size floor)
  min_mean_r_ci_lower: number; // > 0 — PRIMARY statistical floor
  min_oos_held_out_trades: number; // ≥ 10
  max_oos_r_delta_pct: number; // |oos_r_delta_pct| ≤ 50
}

/** v2 criteria locked at the meta-pre-registration commit. Matches
 *  scripts/canonical/algo-search.spec.md §4 exactly. */
export const SEARCH_LAYER_A_CRITERIA: SearchCriteria = {
  min_total_return: 0,
  max_static_dd_pct: 10,
  max_daily_dd_pct: 5,
  min_total_trades: 30,
  min_mean_r_ci_lower: 0,
  min_oos_held_out_trades: 10,
  max_oos_r_delta_pct: 50,
};

/** Patterns exempt from the cross-row pattern-robustness check (criterion 9).
 *  Listed because of structural enumeration constraints — e.g. asian_range_break
 *  is enumerated on 4h ONLY (session-aware cadence), so it CAN'T satisfy ≥2 TFs
 *  of the same instrument. These patterns flag for operator review at acceptance
 *  rather than auto-EXCLUDE. Match against the lowercase pattern key. */
export const ROBUSTNESS_EXEMPT_PATTERNS = new Set<string>([
  "asian_range_break",
  "AsianRangeBreak",
]);

/** Subset of algorithms.backtest_results we read. Matches validate-algo.ts
 *  GateResults shape; only the fields we need are typed (others ignored).
 *  win_rate + Bonferroni are still READ (for informational display) but
 *  not used as v2 hard gates. */
export interface PersistedBacktestResults {
  step2?: {
    total_return?: number;
    total_trades?: number;
    win_rate?: number;
    max_static_dd?: number;
    max_daily_dd?: number;
    verdict?: string;
  };
  step6?: {
    held_out_n?: number;
    r_delta_pct?: number;
    verdict?: string;
  };
  statistical_rigor?: {
    mean_r_ci?: { lower?: number };
    mean_r_bonferroni?: { p_value?: number; passes?: boolean };
  };
  preregistration?: { passed?: boolean };
  promotion_eligible?: boolean;
  promotion_blockers?: string[];
}

export interface CriterionResult {
  key: keyof SearchCriteria;
  label: string;
  passed: boolean;
  /** Observed value (number) or null when the result hasn't been computed
   *  yet (no backtest run). Frontend renders "—" for null. */
  observed: number | null;
  threshold: number;
}

/** Classify a single backtest_results JSONB row against the per-candidate
 *  criteria (v2 criteria 1–8 from spec §4; criterion 9 pattern-robustness
 *  is cross-row and lives in state.ts). Returns one CriterionResult per
 *  criterion (always 7 entries, even when the backtest is missing — those
 *  report passed=false + observed=null so the frontend can show "not yet
 *  evaluated" instead of a silent pass). */
export function evaluateAgainstCriteria(
  results: PersistedBacktestResults | null | undefined,
  criteria: SearchCriteria = SEARCH_LAYER_A_CRITERIA,
): CriterionResult[] {
  const r = results ?? {};
  const step2 = r.step2 ?? {};
  const step6 = r.step6 ?? {};
  const rigor = r.statistical_rigor ?? {};
  const meanRCi = rigor.mean_r_ci ?? {};

  // pickNum: returns null when the field is undefined OR NaN (NaN observations
  // must NOT be treated as zero — a zero-trade algo would silently pass the
  // mean-R CI gate that way).
  const pickNum = (n: number | undefined): number | null =>
    n === undefined || Number.isNaN(n) ? null : n;

  const passedMin = (obs: number | null, threshold: number): boolean =>
    obs !== null && obs > threshold;
  const passedMinEq = (obs: number | null, threshold: number): boolean =>
    obs !== null && obs >= threshold;
  const passedMax = (obs: number | null, threshold: number): boolean =>
    obs !== null && obs <= threshold;
  const passedAbsMax = (obs: number | null, threshold: number): boolean =>
    obs !== null && Math.abs(obs) <= threshold;

  const totalReturn = pickNum(step2.total_return);
  const staticDd = pickNum(step2.max_static_dd);
  const dailyDd = pickNum(step2.max_daily_dd);
  const totalTrades = pickNum(step2.total_trades);
  const meanRLower = pickNum(meanRCi.lower);
  const oosHeldOut = pickNum(step6.held_out_n);
  const oosDelta = pickNum(step6.r_delta_pct);

  return [
    { key: "min_total_return", label: "total_return > 0", passed: passedMin(totalReturn, criteria.min_total_return), observed: totalReturn, threshold: criteria.min_total_return },
    { key: "min_total_trades", label: `trades ≥ ${criteria.min_total_trades}`, passed: passedMinEq(totalTrades, criteria.min_total_trades), observed: totalTrades, threshold: criteria.min_total_trades },
    { key: "max_static_dd_pct", label: `static_dd ≤ ${criteria.max_static_dd_pct}%`, passed: passedMax(staticDd, criteria.max_static_dd_pct), observed: staticDd, threshold: criteria.max_static_dd_pct },
    { key: "max_daily_dd_pct", label: `daily_dd ≤ ${criteria.max_daily_dd_pct}%`, passed: passedMax(dailyDd, criteria.max_daily_dd_pct), observed: dailyDd, threshold: criteria.max_daily_dd_pct },
    { key: "min_mean_r_ci_lower", label: "mean R CI lower > 0", passed: passedMin(meanRLower, criteria.min_mean_r_ci_lower), observed: meanRLower, threshold: criteria.min_mean_r_ci_lower },
    { key: "min_oos_held_out_trades", label: `held-out trades ≥ ${criteria.min_oos_held_out_trades}`, passed: passedMinEq(oosHeldOut, criteria.min_oos_held_out_trades), observed: oosHeldOut, threshold: criteria.min_oos_held_out_trades },
    { key: "max_oos_r_delta_pct", label: `|oos R delta| ≤ ${criteria.max_oos_r_delta_pct}%`, passed: passedAbsMax(oosDelta, criteria.max_oos_r_delta_pct), observed: oosDelta, threshold: criteria.max_oos_r_delta_pct },
  ];
}

/** A row passes per-candidate criteria (criteria 1–8) iff all 7 pass. The
 *  pattern-robustness check (criterion 9) is separate and lives in state.ts
 *  because it needs cross-row knowledge. Use `passesPerCandidate` for the
 *  per-row check; use `state.ts:buildSearchState` for full Layer A survivor
 *  classification including robustness. */
export function passesPerCandidate(results: PersistedBacktestResults | null | undefined): boolean {
  return evaluateAgainstCriteria(results).every((c) => c.passed);
}

/** Legacy alias for callers that imported `passesLayerA` under v1. The v2
 *  Layer A check ALSO requires cross-row pattern robustness (criterion 9),
 *  which a single-row evaluator CAN'T verify. Callers wanting the full Layer
 *  A verdict must use `state.ts:buildSearchState`. This alias preserves the
 *  v1 import for the per-candidate portion only. */
export const passesLayerA = passesPerCandidate;
