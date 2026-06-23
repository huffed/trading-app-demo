/**
 * Pre-registered acceptance criteria for the algorithm search.
 *
 * Criteria + lineage are committed in `scripts/canonical/algo-search.spec.md`
 * (§4 = active thresholds, top-of-file = v1 → v2 → v3 history). This module is
 * the executable mirror — same floors, callable from anywhere (driver,
 * frontend, ad-hoc query). Used by:
 *   - src/lib/algo-search/state.ts (frontend /reports Search tab)
 *   - any future scripts that need to re-evaluate persisted backtest_results
 *
 * NOTE: validate-algo.ts performs its own pre-reg check via
 * `src/lib/stats/preregistration.ts` — that path uses a separate legacy
 * criteria set (WR + Bonferroni) carried forward for non-search callers.
 * This module is the search-specific READ side that applies the active
 * spec §4 criteria to persisted JSONB. The two coexist: validate-algo's
 * `promotion_eligible` flag is a separate signal from `passesPerCandidate`
 * here.
 */

/** Per-candidate hard criteria (spec §4 criteria 1–7 — Layer A floors). */
export interface SearchCriteria {
  min_total_return: number; // > 0
  max_static_dd_pct: number; // ≤ 10 (FTMO)
  max_daily_dd_pct: number; // ≤ 5 (FTMO)
  min_total_trades: number; // ≥ 30 (sample-size floor)
  min_mean_r_ci_lower: number; // > 0 — PRIMARY statistical floor
  min_oos_held_out_trades: number; // ≥ 10
  max_oos_r_delta_pct: number; // |oos_r_delta_pct| ≤ 50
}

/** Per-candidate thresholds locked at the meta-pre-registration commit.
 *  Matches scripts/canonical/algo-search.spec.md §4 exactly. */
export const SEARCH_LAYER_A_CRITERIA: SearchCriteria = {
  min_total_return: 0,
  max_static_dd_pct: 10,
  max_daily_dd_pct: 5,
  min_total_trades: 30,
  min_mean_r_ci_lower: 0,
  min_oos_held_out_trades: 10,
  max_oos_r_delta_pct: 50,
};

/** Patterns exempt from any cross-row pattern-robustness check. Listed
 *  because of structural enumeration constraints — e.g. asian_range_break
 *  is enumerated on 4h ONLY (session-aware cadence), so it CAN'T satisfy
 *  ≥2 TFs of the same instrument. Retained for downstream callers that
 *  still want the exemption set; the active spec §4 no longer gates on
 *  pattern-robustness directly. Match against the lowercase pattern key. */
export const ROBUSTNESS_EXEMPT_PATTERNS = new Set<string>([
  "asian_range_break",
  "AsianRangeBreak",
]);

/** Subset of algorithms.backtest_results we read. Matches validate-algo.ts
 *  GateResults shape; only the fields we need are typed (others ignored).
 *  win_rate + Bonferroni are still READ (for informational display) but
 *  not used as per-candidate hard gates. */
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

/** Deflated-criterion result. Distinct from `CriterionResult` because the
 *  key namespace (DSR / PBO / k-fold) doesn't overlap SearchCriteria. */
export interface DeflatedCriterionResult {
  key: "min_deflated_sharpe" | "max_pbo" | "min_purged_kfold_pass_ratio";
  label: string;
  passed: boolean;
  observed: number | null;
  threshold: number;
}

/** Classify a single backtest_results JSONB row against the per-candidate
 *  criteria (spec §4 criteria 1–7). Returns one CriterionResult per
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

/** A row passes per-candidate criteria 1–7 iff all 7 pass. Ship-readiness
 *  additionally requires criteria 8–10 (DSR + PBO + k-fold consistency) which
 *  need the `statistical_rigor.deflated` block populated by
 *  revalidate-candidates. Use `passesPerCandidate` for the per-row floor;
 *  `passesShipCriteria` combines with the deflated check. */
export function passesPerCandidate(results: PersistedBacktestResults | null | undefined): boolean {
  return evaluateAgainstCriteria(results).every((c) => c.passed);
}

/** Legacy alias for callers that imported `passesLayerA` historically. */
export const passesLayerA = passesPerCandidate;

// ────────────────────────────────────────────────────────────────────────────
// Deflated criteria (spec §4 criteria 8–10) — DSR + PBO + purged k-fold
// ────────────────────────────────────────────────────────────────────────────

/** Ship-thresholds for the deflated statistics. Locked per spec §4. */
export interface DeflatedCriteria {
  /** DSR ≥ this threshold. 0.95 is the analogue of one-sided p ≤ 0.05. */
  min_deflated_sharpe: number;
  /** PBO < this threshold. 0.5 is "more likely real than not." */
  max_pbo: number;
  /** purged k-fold consistency: (folds with positive R) / (total folds).
   *  0.8 = 4/5 for k=5; the standard minimum. */
  min_purged_kfold_pass_ratio: number;
}

export const DEFLATED_CRITERIA: DeflatedCriteria = {
  min_deflated_sharpe: 0.95,
  max_pbo: 0.5,
  min_purged_kfold_pass_ratio: 0.8,
};

/** Parsed shape of `statistical_rigor.deflated` as populated by
 *  scripts/canonical/revalidate-candidates.ts. Optional fields all
 *  marked because partial/missing blocks must fail gracefully (not crash). */
export interface DeflatedBlock {
  deflated_sharpe?: { deflatedSharpe?: number };
  pbo?: { probabilityOfBacktestOverfitting?: number };
  purged_kfold_snapshot?: { consistency_count?: number; n_folds?: number } | null;
}

/** Classify a deflated block against spec §4 criteria 8–10. Returns 3
 *  CriterionResult entries (DSR, PBO, k-fold). Missing block OR missing
 *  field → criterion fails with observed=null (conservative: can't claim
 *  ship pass without the deflated evaluation having run). */
export function evaluateDeflatedCriteria(
  deflated: DeflatedBlock | null | undefined,
  criteria: DeflatedCriteria = DEFLATED_CRITERIA,
): DeflatedCriterionResult[] {
  const d = deflated ?? {};
  const dsr = d.deflated_sharpe?.deflatedSharpe;
  const pbo = d.pbo?.probabilityOfBacktestOverfitting;
  const kfold = d.purged_kfold_snapshot;

  const dsrPassed = typeof dsr === "number" && !Number.isNaN(dsr) && dsr >= criteria.min_deflated_sharpe;
  const pboPassed = typeof pbo === "number" && !Number.isNaN(pbo) && pbo < criteria.max_pbo;
  const kfoldRatio =
    kfold && typeof kfold.consistency_count === "number" && typeof kfold.n_folds === "number" && kfold.n_folds > 0
      ? kfold.consistency_count / kfold.n_folds
      : null;
  const kfoldPassed = kfoldRatio !== null && kfoldRatio >= criteria.min_purged_kfold_pass_ratio;

  return [
    {
      key: "min_deflated_sharpe",
      label: `DSR ≥ ${criteria.min_deflated_sharpe}`,
      passed: dsrPassed,
      observed: typeof dsr === "number" ? dsr : null,
      threshold: criteria.min_deflated_sharpe,
    },
    {
      key: "max_pbo",
      label: `PBO < ${criteria.max_pbo}`,
      passed: pboPassed,
      observed: typeof pbo === "number" ? pbo : null,
      threshold: criteria.max_pbo,
    },
    {
      key: "min_purged_kfold_pass_ratio",
      label: `k-fold consistency ≥ ${(criteria.min_purged_kfold_pass_ratio * 100).toFixed(0)}%`,
      passed: kfoldPassed,
      observed: kfoldRatio,
      threshold: criteria.min_purged_kfold_pass_ratio,
    },
  ];
}

/** A row is ship-ready iff per-candidate criteria 1–7 pass AND deflated
 *  criteria 8–10 pass. Use this for ship/no-ship decisions. */
export function passesShipCriteria(
  results: PersistedBacktestResults | null | undefined,
  deflated: DeflatedBlock | null | undefined,
): boolean {
  return passesPerCandidate(results) && evaluateDeflatedCriteria(deflated).every((c) => c.passed);
}
