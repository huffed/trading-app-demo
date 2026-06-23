/**
 * Pre-registered acceptance criteria for the algorithm search.
 *
 * The criteria are committed in `scripts/canonical/algo-search.spec.md` §4
 * (the meta-pre-registration). This module is the executable mirror — same
 * floors, callable from anywhere (driver, frontend, ad-hoc query). Used by:
 *   - src/lib/algo-search/state.ts (frontend /reports Search tab)
 *   - any future scripts that need to re-evaluate persisted backtest_results
 *
 * NOTE: validate-algo.ts performs the AUTHORITATIVE pre-reg check via
 * `src/lib/stats/preregistration.ts`. This module is for the search-level
 * READ side — given algorithms.backtest_results JSONB, classify the row
 * against the search criteria. The driver doesn't call this (it relies on
 * validate-algo's own JSONB writes); only the frontend + ad-hoc queries do.
 */

/** The 9 hard criteria from spec §4 Layer A floors. */
export interface SearchCriteria {
  min_total_return: number; // > 0
  min_win_rate_pct: number; // ≥ 37 (operator floor)
  max_static_dd_pct: number; // ≤ 10 (FTMO)
  max_daily_dd_pct: number; // ≤ 5 (FTMO)
  min_total_trades: number; // ≥ 30 (sample-size floor)
  min_mean_r_ci_lower: number; // > 0
  /** Family α / Bonferroni denominator. With family α=0.05 and N=308
   *  Layer A cells, per-test α = 0.05/308 ≈ 1.623e-4. */
  max_bonferroni_p_value: number;
  min_oos_held_out_trades: number; // ≥ 10
  max_oos_r_delta_pct: number; // |oos_r_delta_pct| ≤ 50
}

/** Criteria locked at the meta-pre-registration commit. Matches
 *  scripts/canonical/algo-search.spec.md §4 exactly. */
export const SEARCH_LAYER_A_CRITERIA: SearchCriteria = {
  min_total_return: 0,
  min_win_rate_pct: 37,
  max_static_dd_pct: 10,
  max_daily_dd_pct: 5,
  min_total_trades: 30,
  min_mean_r_ci_lower: 0,
  // Family α=0.05 / N=308. validate-algo computes the actual Bonferroni
  // pass/fail using its own bonferroni_alpha = family_alpha / n_tests; this
  // value is the CRITERIA cap we re-check post-hoc against persisted p.
  max_bonferroni_p_value: 0.05 / 308,
  min_oos_held_out_trades: 10,
  max_oos_r_delta_pct: 50,
};

/** Subset of algorithms.backtest_results we read. Matches validate-algo.ts
 *  GateResults shape; only the fields we need are typed (others ignored). */
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

/** Classify a single backtest_results JSONB row against the search criteria.
 *  Returns one CriterionResult per criterion (always 9 entries, even when
 *  the backtest is missing — those report passed=false + observed=null so
 *  the frontend can show "not yet evaluated" instead of a silent pass). */
export function evaluateAgainstCriteria(
  results: PersistedBacktestResults | null | undefined,
  criteria: SearchCriteria = SEARCH_LAYER_A_CRITERIA,
): CriterionResult[] {
  const r = results ?? {};
  const step2 = r.step2 ?? {};
  const step6 = r.step6 ?? {};
  const rigor = r.statistical_rigor ?? {};
  const meanRCi = rigor.mean_r_ci ?? {};
  const bonf = rigor.mean_r_bonferroni ?? {};

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
  const winRate = pickNum(step2.win_rate);
  const staticDd = pickNum(step2.max_static_dd);
  const dailyDd = pickNum(step2.max_daily_dd);
  const totalTrades = pickNum(step2.total_trades);
  const meanRLower = pickNum(meanRCi.lower);
  const bonfP = pickNum(bonf.p_value);
  const oosHeldOut = pickNum(step6.held_out_n);
  const oosDelta = pickNum(step6.r_delta_pct);

  return [
    { key: "min_total_return", label: "total_return > 0", passed: passedMin(totalReturn, criteria.min_total_return), observed: totalReturn, threshold: criteria.min_total_return },
    { key: "min_win_rate_pct", label: `WR ≥ ${criteria.min_win_rate_pct}%`, passed: passedMinEq(winRate, criteria.min_win_rate_pct), observed: winRate, threshold: criteria.min_win_rate_pct },
    { key: "max_static_dd_pct", label: `static_dd ≤ ${criteria.max_static_dd_pct}%`, passed: passedMax(staticDd, criteria.max_static_dd_pct), observed: staticDd, threshold: criteria.max_static_dd_pct },
    { key: "max_daily_dd_pct", label: `daily_dd ≤ ${criteria.max_daily_dd_pct}%`, passed: passedMax(dailyDd, criteria.max_daily_dd_pct), observed: dailyDd, threshold: criteria.max_daily_dd_pct },
    { key: "min_total_trades", label: `trades ≥ ${criteria.min_total_trades}`, passed: passedMinEq(totalTrades, criteria.min_total_trades), observed: totalTrades, threshold: criteria.min_total_trades },
    { key: "min_mean_r_ci_lower", label: "mean R CI lower > 0", passed: passedMin(meanRLower, criteria.min_mean_r_ci_lower), observed: meanRLower, threshold: criteria.min_mean_r_ci_lower },
    { key: "max_bonferroni_p_value", label: `Bonferroni p ≤ ${criteria.max_bonferroni_p_value.toExponential(2)}`, passed: passedMax(bonfP, criteria.max_bonferroni_p_value), observed: bonfP, threshold: criteria.max_bonferroni_p_value },
    { key: "min_oos_held_out_trades", label: `held-out trades ≥ ${criteria.min_oos_held_out_trades}`, passed: passedMinEq(oosHeldOut, criteria.min_oos_held_out_trades), observed: oosHeldOut, threshold: criteria.min_oos_held_out_trades },
    { key: "max_oos_r_delta_pct", label: `|oos R delta| ≤ ${criteria.max_oos_r_delta_pct}%`, passed: passedAbsMax(oosDelta, criteria.max_oos_r_delta_pct), observed: oosDelta, threshold: criteria.max_oos_r_delta_pct },
  ];
}

/** A row passes Layer A iff all 9 criteria pass. */
export function passesLayerA(results: PersistedBacktestResults | null | undefined): boolean {
  return evaluateAgainstCriteria(results).every((c) => c.passed);
}
