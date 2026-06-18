import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  checkPreregistration,
  getPreregistration,
  loadPreregistrations,
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
        registration_type: "post-hoc-locked",
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
        registration_type: "post-hoc-locked",
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
        registration_type: "post-hoc-locked",
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
        registration_type: "post-hoc-locked",
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
        registration_type: "post-hoc-locked",
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
        registration_type: "post-hoc-locked",
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
        registration_type: "post-hoc-locked",
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
        registration_type: "post-hoc-locked",
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
        registration_type: "post-hoc-locked",
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
        registration_type: "post-hoc-locked",
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
        registration_type: "post-hoc-locked",
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
        registration_type: "post-hoc-locked",
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
        registration_type: "post-hoc-locked",
        min_total_return: 5000,
        min_win_rate: 60,
        min_held_out_trades: 30,
      },
    };
    const check = checkPreregistration("Test", baseObserved, file, NOW);
    expect(check.passed).toBe(false);
    expect(check.failed_criteria.length).toBe(3);
  });

  it("B.2.7: registration_type surfaced in check result", () => {
    const file: PreregistrationFile = {
      "Test": {
        hypothesis: "type-test",
        registered_at: "2026-06-01T00:00:00Z",
        expires_at: "2026-07-01T00:00:00Z",
        registration_type: "true-prereg",
      },
    };
    const check = checkPreregistration("Test", baseObserved, file, NOW);
    expect(check.registration_type).toBe("true-prereg");
  });
});

describe("loadPreregistrations Zod schema (B.2.8)", () => {
  let tmp: string;
  let path: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "prereg-test-"));
    path = join(tmp, "preregistration.json");
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("loads a valid file", () => {
    writeFileSync(path, JSON.stringify({
      "Algo A": {
        hypothesis: "real",
        registered_at: "2026-06-01T00:00:00Z",
        expires_at: "2026-07-01T00:00:00Z",
        registration_type: "post-hoc-locked",
        max_bonferroni_p_value: 0.01,
      },
    }));
    const file = loadPreregistrations(path);
    expect(file["Algo A"]).toBeDefined();
    expect(file["Algo A"].registration_type).toBe("post-hoc-locked");
  });

  it("returns empty for non-existent file (no throw)", () => {
    expect(loadPreregistrations(join(tmp, "missing.json"))).toEqual({});
  });

  it("THROWS on missing registration_type (B.2.7 required)", () => {
    writeFileSync(path, JSON.stringify({
      "Algo A": {
        hypothesis: "missing type",
        registered_at: "2026-06-01T00:00:00Z",
        expires_at: "2026-07-01T00:00:00Z",
      },
    }));
    expect(() => loadPreregistrations(path)).toThrowError(/registration_type/);
  });

  it("THROWS on invalid registration_type value", () => {
    writeFileSync(path, JSON.stringify({
      "Algo A": {
        hypothesis: "bad type",
        registered_at: "2026-06-01T00:00:00Z",
        expires_at: "2026-07-01T00:00:00Z",
        registration_type: "guessing",
      },
    }));
    expect(() => loadPreregistrations(path)).toThrow();
  });

  it("THROWS on typo'd field (strict schema — B.2.8 core motivation)", () => {
    writeFileSync(path, JSON.stringify({
      "Algo A": {
        hypothesis: "typo",
        registered_at: "2026-06-01T00:00:00Z",
        expires_at: "2026-07-01T00:00:00Z",
        registration_type: "post-hoc-locked",
        min_static_dd: 5,
      },
    }));
    expect(() => loadPreregistrations(path)).toThrowError(/min_static_dd/);
  });

  it("THROWS on invalid date string in registered_at", () => {
    writeFileSync(path, JSON.stringify({
      "Algo A": {
        hypothesis: "bad date",
        registered_at: "yesterday",
        expires_at: "2026-07-01T00:00:00Z",
        registration_type: "post-hoc-locked",
      },
    }));
    expect(() => loadPreregistrations(path)).toThrow();
  });

  it("THROWS on empty hypothesis string", () => {
    writeFileSync(path, JSON.stringify({
      "Algo A": {
        hypothesis: "",
        registered_at: "2026-06-01T00:00:00Z",
        expires_at: "2026-07-01T00:00:00Z",
        registration_type: "post-hoc-locked",
      },
    }));
    expect(() => loadPreregistrations(path)).toThrow();
  });

  it("accepts true-prereg as a valid registration_type", () => {
    writeFileSync(path, JSON.stringify({
      "Algo A": {
        hypothesis: "real prereg",
        registered_at: "2026-06-01T00:00:00Z",
        expires_at: "2026-07-01T00:00:00Z",
        registration_type: "true-prereg",
      },
    }));
    const file = loadPreregistrations(path);
    expect(file["Algo A"].registration_type).toBe("true-prereg");
  });

  it("error message identifies the failing field path", () => {
    writeFileSync(path, JSON.stringify({
      "Algo A": {
        hypothesis: "x",
        registered_at: "2026-06-01T00:00:00Z",
        expires_at: "2026-07-01T00:00:00Z",
        registration_type: "post-hoc-locked",
        max_static_dd: "ten",
      },
    }));
    expect(() => loadPreregistrations(path)).toThrowError(/max_static_dd/);
  });
});
