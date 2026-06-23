/**
 * Criteria evaluator tests. Locks the threshold semantics + NaN handling
 * so the frontend Search tab doesn't silently mis-classify rows.
 */
import { describe, expect, it } from "vitest";
import {
  evaluateAgainstCriteria,
  passesLayerA,
  SEARCH_LAYER_A_CRITERIA,
  type PersistedBacktestResults,
} from "./criteria";

const FULL_PASS: PersistedBacktestResults = {
  step2: { total_return: 1500, total_trades: 60, win_rate: 42, max_static_dd: 4, max_daily_dd: 2 },
  step6: { held_out_n: 15, r_delta_pct: -10 },
  statistical_rigor: {
    mean_r_ci: { lower: 0.1 },
    mean_r_bonferroni: { p_value: 1e-5 },
  },
};

describe("evaluateAgainstCriteria", () => {
  it("returns exactly 9 entries (one per criterion in spec §4)", () => {
    const r = evaluateAgainstCriteria(null);
    expect(r).toHaveLength(9);
  });

  it("null results → all 9 fail with observed=null (no silent pass on unevaluated rows)", () => {
    const r = evaluateAgainstCriteria(null);
    expect(r.every((c) => !c.passed)).toBe(true);
    expect(r.every((c) => c.observed === null)).toBe(true);
  });

  it("full-pass fixture → all 9 pass", () => {
    const r = evaluateAgainstCriteria(FULL_PASS);
    expect(r.every((c) => c.passed)).toBe(true);
    expect(passesLayerA(FULL_PASS)).toBe(true);
  });

  it("min_total_return uses strict > (return=0 fails — net negative once friction lands)", () => {
    const zeroReturn: PersistedBacktestResults = { ...FULL_PASS, step2: { ...FULL_PASS.step2, total_return: 0 } };
    expect(passesLayerA(zeroReturn)).toBe(false);
  });

  it("WR floor is operator-locked 37 — 36.9% fails", () => {
    const lowWR: PersistedBacktestResults = { ...FULL_PASS, step2: { ...FULL_PASS.step2, win_rate: 36.9 } };
    expect(passesLayerA(lowWR)).toBe(false);
    const exactly37: PersistedBacktestResults = { ...FULL_PASS, step2: { ...FULL_PASS.step2, win_rate: 37 } };
    expect(passesLayerA(exactly37)).toBe(true);
  });

  it("DD gates use ≤ (exactly 10% static / 5% daily passes; 10.01% / 5.01% fails)", () => {
    const dd10: PersistedBacktestResults = { ...FULL_PASS, step2: { ...FULL_PASS.step2, max_static_dd: 10, max_daily_dd: 5 } };
    expect(passesLayerA(dd10)).toBe(true);
    const overStatic: PersistedBacktestResults = { ...FULL_PASS, step2: { ...FULL_PASS.step2, max_static_dd: 10.01 } };
    expect(passesLayerA(overStatic)).toBe(false);
  });

  it("sample-size floor is 30 trades", () => {
    const low: PersistedBacktestResults = { ...FULL_PASS, step2: { ...FULL_PASS.step2, total_trades: 29 } };
    expect(passesLayerA(low)).toBe(false);
  });

  it("Bonferroni threshold = family α / N (spec §4)", () => {
    // SEARCH_LAYER_A_CRITERIA.max_bonferroni_p_value = 0.05/308 ≈ 1.623e-4
    expect(SEARCH_LAYER_A_CRITERIA.max_bonferroni_p_value).toBeCloseTo(0.05 / 308, 10);
    const justOver: PersistedBacktestResults = {
      ...FULL_PASS,
      statistical_rigor: { ...FULL_PASS.statistical_rigor, mean_r_bonferroni: { p_value: 0.05 / 307 } },
    };
    expect(passesLayerA(justOver)).toBe(false);
  });

  it("oos_r_delta uses |abs| ≤ 50% — both +60% and -60% fail; -50% passes", () => {
    const over: PersistedBacktestResults = { ...FULL_PASS, step6: { ...FULL_PASS.step6, r_delta_pct: 60 } };
    expect(passesLayerA(over)).toBe(false);
    const neg: PersistedBacktestResults = { ...FULL_PASS, step6: { ...FULL_PASS.step6, r_delta_pct: -60 } };
    expect(passesLayerA(neg)).toBe(false);
    const edge: PersistedBacktestResults = { ...FULL_PASS, step6: { ...FULL_PASS.step6, r_delta_pct: -50 } };
    expect(passesLayerA(edge)).toBe(true);
  });

  it("NaN observed values fail loud (not silent-pass)", () => {
    const nanCi: PersistedBacktestResults = {
      ...FULL_PASS,
      statistical_rigor: { ...FULL_PASS.statistical_rigor, mean_r_ci: { lower: NaN } },
    };
    expect(passesLayerA(nanCi)).toBe(false);
    const ciResult = evaluateAgainstCriteria(nanCi).find((c) => c.key === "min_mean_r_ci_lower");
    expect(ciResult?.observed).toBeNull();
  });
});
