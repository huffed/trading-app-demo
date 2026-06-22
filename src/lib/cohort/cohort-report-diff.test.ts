/**
 * SG.6.2 — regression tests for cohort-report-diff (2026-06-22 NIGHT LATE).
 *
 * Pure-function diff helper — drives synthetic CohortReport pairs to
 * verify the contract:
 *
 *  - Identity key = `${dimension}:${value}` (so the same cohort across
 *    two reports matches even if their inner stats moved)
 *  - new_X = items in latest but NOT in prior (set difference)
 *  - disappeared_X = items in prior but NOT in latest (set difference)
 *  - trade_growth = latest.total_trades − prior.total_trades (signed)
 *  - isQuietDiff returns true iff all 4 change-lists are empty
 *
 * Coverage (~12 tests):
 *
 *  diffCohortReports (8):
 *   - Identical reports → all change-lists empty, trade_growth=0
 *   - New decay flag in latest → surfaces in new_decay_flags only
 *   - Disappeared decay flag (gone from latest) → surfaces in disappeared only
 *   - Same cohort key with different stats → NOT counted as new (stats moved, not cohort)
 *   - New shadow candidate in latest → surfaces in new_shadow_candidates
 *   - Disappeared shadow candidate → surfaces in disappeared_shadow_candidates
 *   - trade_growth positive when latest > prior
 *   - trade_growth negative when latest < prior (e.g. metrics reset)
 *
 *  isQuietDiff (4):
 *   - All 4 change-lists empty → true
 *   - Any one non-empty → false (one test per list)
 */
import { describe, expect, it } from "vitest";
import { diffCohortReports, isQuietDiff } from "./cohort-report-diff";
import type { CohortReport, DecayFlag, ShadowGateCandidate } from "./cohort-report";

function flag(overrides: Partial<DecayFlag> = {}): DecayFlag {
  return {
    dimension: "regime",
    value: "chop",
    recent_mean_r: -0.1,
    prior_mean_r: 0.5,
    recent_wr_pct: 30,
    prior_wr_pct: 55,
    recent_n: 10,
    prior_n: 10,
    mean_drop: 0.6,
    wr_drop_pp: 25,
    ...overrides,
  };
}

function candidate(overrides: Partial<ShadowGateCandidate> = {}): ShadowGateCandidate {
  return {
    dimension: "regime",
    value: "chop",
    n: 10,
    mean_r: -0.5,
    rationale: "regime=chop (n=10, meanR -0.50) → propose LOG-ONLY gate scoped per algo+prompt_version; enforce only after shadow evidence",
    ...overrides,
  };
}

function makeReport(overrides: Partial<CohortReport> = {}): CohortReport {
  return {
    generated_at: "2026-06-22T00:00:00.000Z",
    source: "live",
    days: 14,
    min_n: 5,
    total_trades: 50,
    trades_with_zone_tags: 50,
    trades_skipped_no_r: 0,
    dimensions: [],
    decay_flags: [],
    shadow_gate_candidates: [],
    ...overrides,
  };
}

// ======================================================================
// diffCohortReports
// ======================================================================

describe("diffCohortReports", () => {
  it("identical reports → all change-lists empty, trade_growth=0", () => {
    const r = makeReport({ total_trades: 50 });
    const diff = diffCohortReports(r, r);
    expect(diff.new_decay_flags).toEqual([]);
    expect(diff.disappeared_decay_flags).toEqual([]);
    expect(diff.new_shadow_candidates).toEqual([]);
    expect(diff.disappeared_shadow_candidates).toEqual([]);
    expect(diff.trade_growth).toBe(0);
    expect(diff.prior_generated_at).toBe(r.generated_at);
    expect(diff.latest_generated_at).toBe(r.generated_at);
  });

  it("new decay flag in latest → surfaces in new_decay_flags only", () => {
    const prior = makeReport({ decay_flags: [] });
    const latest = makeReport({ decay_flags: [flag({ dimension: "regime", value: "chop" })] });
    const diff = diffCohortReports(prior, latest);
    expect(diff.new_decay_flags).toHaveLength(1);
    expect(diff.new_decay_flags[0].value).toBe("chop");
    expect(diff.disappeared_decay_flags).toEqual([]);
  });

  it("disappeared decay flag (gone from latest) → surfaces in disappeared only", () => {
    const prior = makeReport({ decay_flags: [flag({ dimension: "regime", value: "trend" })] });
    const latest = makeReport({ decay_flags: [] });
    const diff = diffCohortReports(prior, latest);
    expect(diff.disappeared_decay_flags).toHaveLength(1);
    expect(diff.disappeared_decay_flags[0].value).toBe("trend");
    expect(diff.new_decay_flags).toEqual([]);
  });

  it("same cohort key with different stats → NOT counted as new (stats moved, cohort persists)", () => {
    // dimension=regime value=chop in both, but recent_mean_r differs
    const prior = makeReport({
      decay_flags: [flag({ value: "chop", recent_mean_r: -0.1 })],
    });
    const latest = makeReport({
      decay_flags: [flag({ value: "chop", recent_mean_r: -0.5 })],
    });
    const diff = diffCohortReports(prior, latest);
    expect(diff.new_decay_flags).toEqual([]);
    expect(diff.disappeared_decay_flags).toEqual([]);
  });

  it("new shadow candidate in latest → surfaces in new_shadow_candidates", () => {
    const prior = makeReport({ shadow_gate_candidates: [] });
    const latest = makeReport({
      shadow_gate_candidates: [candidate({ dimension: "side", value: "short" })],
    });
    const diff = diffCohortReports(prior, latest);
    expect(diff.new_shadow_candidates).toHaveLength(1);
    expect(diff.new_shadow_candidates[0].value).toBe("short");
    expect(diff.disappeared_shadow_candidates).toEqual([]);
  });

  it("disappeared shadow candidate → surfaces in disappeared_shadow_candidates", () => {
    const prior = makeReport({
      shadow_gate_candidates: [candidate({ dimension: "session", value: "asia(0-7)" })],
    });
    const latest = makeReport({ shadow_gate_candidates: [] });
    const diff = diffCohortReports(prior, latest);
    expect(diff.disappeared_shadow_candidates).toHaveLength(1);
    expect(diff.disappeared_shadow_candidates[0].value).toBe("asia(0-7)");
  });

  it("trade_growth positive when latest > prior", () => {
    const prior = makeReport({ total_trades: 50 });
    const latest = makeReport({ total_trades: 75 });
    const diff = diffCohortReports(prior, latest);
    expect(diff.trade_growth).toBe(25);
  });

  it("trade_growth negative when latest < prior (e.g. metrics reset)", () => {
    const prior = makeReport({ total_trades: 100 });
    const latest = makeReport({ total_trades: 30 });
    const diff = diffCohortReports(prior, latest);
    expect(diff.trade_growth).toBe(-70);
  });
});

// ======================================================================
// isQuietDiff
// ======================================================================

describe("isQuietDiff", () => {
  function emptyDiff() {
    return {
      prior_generated_at: "",
      latest_generated_at: "",
      trade_growth: 0,
      new_decay_flags: [] as DecayFlag[],
      disappeared_decay_flags: [] as DecayFlag[],
      new_shadow_candidates: [] as ShadowGateCandidate[],
      disappeared_shadow_candidates: [] as ShadowGateCandidate[],
    };
  }

  it("all 4 change-lists empty → true (quiet)", () => {
    expect(isQuietDiff(emptyDiff())).toBe(true);
  });

  it("new_decay_flags non-empty → false", () => {
    const d = emptyDiff();
    d.new_decay_flags = [flag()];
    expect(isQuietDiff(d)).toBe(false);
  });

  it("disappeared_decay_flags non-empty → false", () => {
    const d = emptyDiff();
    d.disappeared_decay_flags = [flag()];
    expect(isQuietDiff(d)).toBe(false);
  });

  it("any shadow change-list non-empty → false", () => {
    const d1 = emptyDiff();
    d1.new_shadow_candidates = [candidate()];
    expect(isQuietDiff(d1)).toBe(false);

    const d2 = emptyDiff();
    d2.disappeared_shadow_candidates = [candidate()];
    expect(isQuietDiff(d2)).toBe(false);
  });
});
