import { describe, expect, it } from "vitest";
import {
  checkPreregistration,
  getPreregistration,
  type ObservedStats,
  type PreregistrationFile,
} from "./preregistration";

const NOW = new Date("2026-06-18T00:00:00Z");

const baseObserved: ObservedStats = {
  total_return: 1000,
  win_rate: 45,
  max_static_dd: 6,
  max_daily_dd: 3,
  mean_r_ci_lower: 0.2,
  bonferroni_p_value: 0.001,
  oos_r_delta_pct: 15,
  held_out_trades: 12,
};

describe("getPreregistration", () => {
  it("returns null for missing algo", () => {
    const file: PreregistrationFile = {};
    expect(getPreregistration(file, "missing", NOW)).toBeNull();
  });

  it("returns entry for non-expired algo", () => {
    const file: PreregistrationFile = {
      "Test Algo": {
        hypothesis: "test",
        registered_at: "2026-06-01T00:00:00Z",
        expires_at: "2026-07-01T00:00:00Z",
      },
    };
    const entry = getPreregistration(file, "Test Algo", NOW);
    expect(entry).not.toBeNull();
    expect(entry?.hypothesis).toBe("test");
  });

  it("returns null for expired registration", () => {
    const file: PreregistrationFile = {
      "Test Algo": {
        hypothesis: "test",
        registered_at: "2026-04-01T00:00:00Z",
        expires_at: "2026-05-01T00:00:00Z",
      },
    };
    expect(getPreregistration(file, "Test Algo", NOW)).toBeNull();
  });

  it("returns null for invalid expires_at", () => {
    const file: PreregistrationFile = {
      "Test Algo": {
        hypothesis: "test",
        registered_at: "2026-06-01T00:00:00Z",
        expires_at: "not-a-date",
      },
    };
    expect(getPreregistration(file, "Test Algo", NOW)).toBeNull();
  });
});

describe("checkPreregistration", () => {
  it("unregistered algo passes (with has_preregistration=false flag)", () => {
    const check = checkPreregistration("Unregistered", baseObserved, {}, NOW);
    expect(check.has_preregistration).toBe(false);
    expect(check.passed).toBe(true);
    expect(check.failed_criteria).toEqual([]);
  });

  it("registered algo meeting all criteria passes", () => {
    const file: PreregistrationFile = {
      "Test": {
        hypothesis: "edge exists",
        registered_at: "2026-06-01T00:00:00Z",
        expires_at: "2026-07-01T00:00:00Z",
        min_total_return: 500,
        min_win_rate: 40,
        max_static_dd: 10,
        max_daily_dd: 5,
        min_mean_r_ci_lower: 0.1,
        max_bonferroni_p_value: 0.01,
        max_oos_r_delta_pct: 50,
        min_held_out_trades: 10,
      },
    };
    const check = checkPreregistration("Test", baseObserved, file, NOW);
    expect(check.passed).toBe(true);
    expect(check.has_preregistration).toBe(true);
    expect(check.failed_criteria).toEqual([]);
  });

  it("fails when min_total_return not met", () => {
    const file: PreregistrationFile = {
      "Test": {
        hypothesis: "min return",
        registered_at: "2026-06-01T00:00:00Z",
        expires_at: "2026-07-01T00:00:00Z",
        min_total_return: 5000,
      },
    };
    const check = checkPreregistration("Test", baseObserved, file, NOW);
    expect(check.passed).toBe(false);
    expect(check.failed_criteria[0]).toMatch(/total_return/);
  });

  it("fails when win_rate below threshold", () => {
    const file: PreregistrationFile = {
      "Test": {
        hypothesis: "wr",
        registered_at: "2026-06-01T00:00:00Z",
        expires_at: "2026-07-01T00:00:00Z",
        min_win_rate: 50,
      },
    };
    const check = checkPreregistration("Test", baseObserved, file, NOW);
    expect(check.passed).toBe(false);
    expect(check.failed_criteria[0]).toMatch(/win_rate/);
  });

  it("fails when static_dd exceeds cap", () => {
    const file: PreregistrationFile = {
      "Test": {
        hypothesis: "dd",
        registered_at: "2026-06-01T00:00:00Z",
        expires_at: "2026-07-01T00:00:00Z",
        max_static_dd: 5,
      },
    };
    const check = checkPreregistration("Test", baseObserved, file, NOW);
    expect(check.passed).toBe(false);
    expect(check.failed_criteria[0]).toMatch(/static_dd/);
  });

  it("fails when bootstrap CI lower bound is below floor", () => {
    const file: PreregistrationFile = {
      "Test": {
        hypothesis: "ci-floor",
        registered_at: "2026-06-01T00:00:00Z",
        expires_at: "2026-07-01T00:00:00Z",
        min_mean_r_ci_lower: 0.5,
      },
    };
    const check = checkPreregistration("Test", baseObserved, file, NOW);
    expect(check.passed).toBe(false);
    expect(check.failed_criteria[0]).toMatch(/mean_r_ci_lower/);
  });

  it("fails when bonferroni p-value exceeds threshold", () => {
    const file: PreregistrationFile = {
      "Test": {
        hypothesis: "mcc",
        registered_at: "2026-06-01T00:00:00Z",
        expires_at: "2026-07-01T00:00:00Z",
        max_bonferroni_p_value: 0.0001,
      },
    };
    const check = checkPreregistration("Test", baseObserved, file, NOW);
    expect(check.passed).toBe(false);
    expect(check.failed_criteria[0]).toMatch(/bonferroni_p/);
  });

  it("fails when oos r-delta beyond tolerance", () => {
    const file: PreregistrationFile = {
      "Test": {
        hypothesis: "oos-stable",
        registered_at: "2026-06-01T00:00:00Z",
        expires_at: "2026-07-01T00:00:00Z",
        max_oos_r_delta_pct: 10,
      },
    };
    const check = checkPreregistration("Test", baseObserved, file, NOW);
    expect(check.passed).toBe(false);
    expect(check.failed_criteria[0]).toMatch(/oos_r_delta/);
  });

  it("fails when held_out_trades below floor", () => {
    const file: PreregistrationFile = {
      "Test": {
        hypothesis: "min-n",
        registered_at: "2026-06-01T00:00:00Z",
        expires_at: "2026-07-01T00:00:00Z",
        min_held_out_trades: 30,
      },
    };
    const check = checkPreregistration("Test", baseObserved, file, NOW);
    expect(check.passed).toBe(false);
    expect(check.failed_criteria[0]).toMatch(/held_out_trades/);
  });

  it("NaN observed value with active criterion fails loudly (regression: B.2.1)", () => {
    // Pre-fix: NaN < threshold returned false → criterion silently passed.
    // Post-fix: NaN observation against ANY active criterion is a failure.
    const file: PreregistrationFile = {
      "ZeroTrade": {
        hypothesis: "edge exists",
        registered_at: "2026-06-01T00:00:00Z",
        expires_at: "2026-07-01T00:00:00Z",
        min_mean_r_ci_lower: 0,
      },
    };
    const observedWithNaN: ObservedStats = {
      ...baseObserved,
      mean_r_ci_lower: NaN,
    };
    const check = checkPreregistration("ZeroTrade", observedWithNaN, file, NOW);
    expect(check.passed).toBe(false);
    expect(check.failed_criteria[0]).toMatch(/mean_r_ci_lower.*NaN/);
  });

  it("collects ALL failed criteria, not just the first", () => {
    const file: PreregistrationFile = {
      "Test": {
        hypothesis: "strict",
        registered_at: "2026-06-01T00:00:00Z",
        expires_at: "2026-07-01T00:00:00Z",
        min_total_return: 5000,
        min_win_rate: 60,
        min_held_out_trades: 30,
      },
    };
    const check = checkPreregistration("Test", baseObserved, file, NOW);
    expect(check.passed).toBe(false);
    expect(check.failed_criteria.length).toBe(3);
  });
});
