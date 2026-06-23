/**
 * Criteria evaluator tests (v2). Locks the per-candidate threshold semantics +
 * NaN handling so the frontend Search tab doesn't silently mis-classify rows.
 * Pattern-robustness (criterion 9) is cross-row and tested in state.test.ts.
 */
import { describe, expect, it } from "vitest";
import {
  evaluateAgainstCriteria,
  passesPerCandidate,
  ROBUSTNESS_EXEMPT_PATTERNS,
  SEARCH_LAYER_A_CRITERIA,
  type PersistedBacktestResults,
} from "./criteria";

const FULL_PASS: PersistedBacktestResults = {
  step2: { total_return: 1500, total_trades: 60, win_rate: 30, max_static_dd: 4, max_daily_dd: 2 },
  step6: { held_out_n: 15, r_delta_pct: -10 },
  statistical_rigor: {
    mean_r_ci: { lower: 0.1 },
    mean_r_bonferroni: { p_value: 0.01 }, // intentionally > 1.62e-4 to prove v2 ignores Bonferroni
  },
};

describe("evaluateAgainstCriteria (v2)", () => {
  it("returns exactly 7 entries (per-candidate criteria 1–8 minus combined oos)", () => {
    const r = evaluateAgainstCriteria(null);
    expect(r).toHaveLength(7);
  });

  it("v2 criteria set does NOT include min_win_rate_pct or max_bonferroni_p_value", () => {
    const keys = evaluateAgainstCriteria(FULL_PASS).map((c) => c.key);
    expect(keys).not.toContain("min_win_rate_pct");
    expect(keys).not.toContain("max_bonferroni_p_value");
  });

  it("null results → all 7 fail with observed=null (no silent pass on unevaluated rows)", () => {
    const r = evaluateAgainstCriteria(null);
    expect(r.every((c) => !c.passed)).toBe(true);
    expect(r.every((c) => c.observed === null)).toBe(true);
  });

  it("full-pass fixture passes ALL 7 even with WR=30 + bonferroni p=0.01 (proves v2 doesn't gate on those)", () => {
    const r = evaluateAgainstCriteria(FULL_PASS);
    expect(r.every((c) => c.passed)).toBe(true);
    expect(passesPerCandidate(FULL_PASS)).toBe(true);
  });

  it("min_total_return uses strict > (return=0 fails — needs to be net positive)", () => {
    const zeroReturn: PersistedBacktestResults = { ...FULL_PASS, step2: { ...FULL_PASS.step2, total_return: 0 } };
    expect(passesPerCandidate(zeroReturn)).toBe(false);
  });

  it("mean R CI lower > 0 IS the primary statistical floor (replaces v1 WR ≥ 37 + Bonferroni)", () => {
    const ciAtZero: PersistedBacktestResults = {
      ...FULL_PASS,
      statistical_rigor: { ...FULL_PASS.statistical_rigor, mean_r_ci: { lower: 0 } },
    };
    expect(passesPerCandidate(ciAtZero)).toBe(false); // strict > 0
    const ciNeg: PersistedBacktestResults = {
      ...FULL_PASS,
      statistical_rigor: { ...FULL_PASS.statistical_rigor, mean_r_ci: { lower: -0.001 } },
    };
    expect(passesPerCandidate(ciNeg)).toBe(false);
    const ciJustPos: PersistedBacktestResults = {
      ...FULL_PASS,
      statistical_rigor: { ...FULL_PASS.statistical_rigor, mean_r_ci: { lower: 0.001 } },
    };
    expect(passesPerCandidate(ciJustPos)).toBe(true);
  });

  it("DD gates use ≤ (exactly 10% static / 5% daily passes; 10.01% / 5.01% fails)", () => {
    const dd10: PersistedBacktestResults = { ...FULL_PASS, step2: { ...FULL_PASS.step2, max_static_dd: 10, max_daily_dd: 5 } };
    expect(passesPerCandidate(dd10)).toBe(true);
    const overStatic: PersistedBacktestResults = { ...FULL_PASS, step2: { ...FULL_PASS.step2, max_static_dd: 10.01 } };
    expect(passesPerCandidate(overStatic)).toBe(false);
  });

  it("sample-size floor is 30 trades", () => {
    const low: PersistedBacktestResults = { ...FULL_PASS, step2: { ...FULL_PASS.step2, total_trades: 29 } };
    expect(passesPerCandidate(low)).toBe(false);
  });

  it("oos_r_delta uses |abs| ≤ 50% — both +60% and -60% fail; -50% passes", () => {
    const over: PersistedBacktestResults = { ...FULL_PASS, step6: { ...FULL_PASS.step6, r_delta_pct: 60 } };
    expect(passesPerCandidate(over)).toBe(false);
    const neg: PersistedBacktestResults = { ...FULL_PASS, step6: { ...FULL_PASS.step6, r_delta_pct: -60 } };
    expect(passesPerCandidate(neg)).toBe(false);
    const edge: PersistedBacktestResults = { ...FULL_PASS, step6: { ...FULL_PASS.step6, r_delta_pct: -50 } };
    expect(passesPerCandidate(edge)).toBe(true);
  });

  it("NaN observed values fail loud (not silent-pass)", () => {
    const nanCi: PersistedBacktestResults = {
      ...FULL_PASS,
      statistical_rigor: { ...FULL_PASS.statistical_rigor, mean_r_ci: { lower: NaN } },
    };
    expect(passesPerCandidate(nanCi)).toBe(false);
    const ciResult = evaluateAgainstCriteria(nanCi).find((c) => c.key === "min_mean_r_ci_lower");
    expect(ciResult?.observed).toBeNull();
  });

  it("v2 SEARCH_LAYER_A_CRITERIA shape (no win_rate, no Bonferroni)", () => {
    expect(SEARCH_LAYER_A_CRITERIA).toEqual({
      min_total_return: 0,
      max_static_dd_pct: 10,
      max_daily_dd_pct: 5,
      min_total_trades: 30,
      min_mean_r_ci_lower: 0,
      min_oos_held_out_trades: 10,
      max_oos_r_delta_pct: 50,
    });
  });

  it("ROBUSTNESS_EXEMPT_PATTERNS includes asian_range_break (4h-only by enumeration)", () => {
    expect(ROBUSTNESS_EXEMPT_PATTERNS.has("asian_range_break")).toBe(true);
    expect(ROBUSTNESS_EXEMPT_PATTERNS.has("AsianRangeBreak")).toBe(true);
  });
});
