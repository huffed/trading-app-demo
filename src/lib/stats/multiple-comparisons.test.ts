import { describe, expect, it } from "vitest";
import {
  bonferroniAlpha,
  bonferroniVerdict,
  bootstrapPValueGtZero,
  bootstrapPValueLtZero,
  bootstrapPValueTwoSided,
  passesAtBonferroni,
} from "./multiple-comparisons";

describe("bonferroniAlpha", () => {
  it("returns alpha when n_tests = 1", () => {
    expect(bonferroniAlpha(0.05, 1)).toBe(0.05);
  });

  it("divides by n_tests for n > 1", () => {
    expect(bonferroniAlpha(0.05, 5)).toBeCloseTo(0.01, 5);
    expect(bonferroniAlpha(0.05, 20)).toBeCloseTo(0.0025, 5);
  });

  it("returns alpha unchanged for n_tests <= 0 (defensive)", () => {
    expect(bonferroniAlpha(0.05, 0)).toBe(0.05);
  });
});

describe("passesAtBonferroni", () => {
  it("requires p < family_alpha / n_tests", () => {
    expect(passesAtBonferroni(0.04, 0.05, 1)).toBe(true);
    expect(passesAtBonferroni(0.04, 0.05, 2)).toBe(false);
    expect(passesAtBonferroni(0.001, 0.05, 20)).toBe(true);
    expect(passesAtBonferroni(0.003, 0.05, 20)).toBe(false);
  });
});

describe("bootstrapPValueGtZero", () => {
  it("returns 1 for empty samples", () => {
    expect(bootstrapPValueGtZero([])).toBe(1);
  });

  it("approximately 0 when all samples > 0", () => {
    const samples = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(bootstrapPValueGtZero(samples)).toBeCloseTo(1 / 11, 3);
  });

  it("approximately 1 when all samples <= 0", () => {
    const samples = [-1, -2, 0, -3, 0];
    expect(bootstrapPValueGtZero(samples)).toBe(1);
  });

  it("0.5 when half positive, half non-positive", () => {
    expect(bootstrapPValueGtZero([1, 2, 3, 4, -1, -2, 0, 0])).toBe(0.5);
  });

  it("never returns 0 (clamps to 1/(N+1))", () => {
    const samples = Array.from({ length: 1000 }, () => 1);
    expect(bootstrapPValueGtZero(samples)).toBeCloseTo(1 / 1001, 5);
  });
});

describe("bootstrapPValueLtZero", () => {
  it("approximately 0 when all samples < 0", () => {
    const samples = [-1, -2, -3, -4, -5];
    expect(bootstrapPValueLtZero(samples)).toBeCloseTo(1 / 6, 3);
  });

  it("approximately 1 when all samples >= 0", () => {
    expect(bootstrapPValueLtZero([0, 1, 2, 3])).toBe(1);
  });
});

describe("bootstrapPValueTwoSided", () => {
  it("approximately 2× one-sided when distribution is one-sided", () => {
    const samples = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(bootstrapPValueTwoSided(samples)).toBeCloseTo(2 / 11, 2);
  });

  it("caps at 1.0", () => {
    expect(bootstrapPValueTwoSided([0, 0, 1])).toBe(1);
  });

  it("symmetric distribution gives p near 1", () => {
    const samples = [-1, -2, -3, 1, 2, 3];
    expect(bootstrapPValueTwoSided(samples)).toBeGreaterThan(0.5);
  });
});

describe("bonferroniVerdict", () => {
  it("strong positive signal passes at family_alpha=0.05 / n=15", () => {
    // 1000 resamples all positive → p ≈ 1/1001 ≈ 0.001
    // Corrected alpha = 0.05/15 ≈ 0.0033
    // 0.001 < 0.0033 → passes
    const samples = Array.from({ length: 1000 }, () => 1.5);
    const verdict = bonferroniVerdict(samples, 0.05, 15);
    expect(verdict.passes).toBe(true);
    expect(verdict.bonferroni_alpha).toBeCloseTo(0.05 / 15, 5);
  });

  it("weak signal fails after correction (n=20)", () => {
    // ~95% positive, 5% non-positive → uncorrected p ≈ 0.05
    // Corrected alpha = 0.05/20 = 0.0025 → does NOT pass
    const samples = [
      ...Array.from({ length: 95 }, () => 1),
      ...Array.from({ length: 5 }, () => -1),
    ];
    const verdict = bonferroniVerdict(samples, 0.05, 20);
    expect(verdict.passes).toBe(false);
    expect(verdict.p_value).toBeGreaterThan(verdict.bonferroni_alpha);
  });

  it("n_tests=1 = no correction (just normal alpha)", () => {
    // Borderline p=0.04, family_alpha=0.05 — passes uncorrected
    const samples = [
      ...Array.from({ length: 96 }, () => 1),
      ...Array.from({ length: 4 }, () => -1),
    ];
    const verdict = bonferroniVerdict(samples, 0.05, 1);
    expect(verdict.passes).toBe(true);
    expect(verdict.bonferroni_alpha).toBe(0.05);
  });

  it("records p_value + alpha + family_alpha + n_tests for traceability", () => {
    const v = bonferroniVerdict([1, 2, 3, -1], 0.05, 3);
    expect(v.family_alpha).toBe(0.05);
    expect(v.n_tests).toBe(3);
    expect(v.bonferroni_alpha).toBeCloseTo(0.05 / 3, 5);
    expect(typeof v.p_value).toBe("number");
  });
});
