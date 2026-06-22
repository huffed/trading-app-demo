/**
 * SG.6 — regression tests for the cohort-report shared aggregation
 * (2026-06-22 NIGHT LATE).
 *
 * Tests the pure `aggregateCohortTrades` step with synthetic trades.
 * `buildCohortReport`'s Supabase-query layer is tested at a smoke
 * level (empty + error paths) — the per-cohort math is the value-add
 * worth contract-locking. The CLI cron + /reports tab share THIS
 * module; a regression here breaks both surfaces simultaneously.
 *
 * Coverage (~14 tests):
 *
 *  aggregateCohortTrades — per-dimension aggregation (4):
 *   - Empty trades → empty dimensions / flags / candidates
 *   - All-time per-dimension bucket counts add up to total
 *   - Buckets sorted by n descending (largest cohort first)
 *   - WR computed as percentage 0-100 (not 0-1)
 *
 *  Decay flags (4):
 *   - Mean R drop ≥ 0.5 → flagged
 *   - WR drop ≥ 20pp → flagged
 *   - Cohort below min_n in either half → NOT flagged (insufficient n)
 *   - Improving cohort (mean R rose) → NOT flagged
 *
 *  Shadow-gate candidates (4):
 *   - n ≥ 8 + meanR ≤ −0.3 → candidate
 *   - n < 8 → not a candidate
 *   - meanR > −0.3 → not a candidate
 *   - exit_reason dimension excluded (it's an outcome, not entry cohort)
 *
 *  buildCohortReport — query-layer smoke (2):
 *   - Empty llm_decisions → CohortReport with total_trades=0
 *   - llm_decisions error → throws (loud failure, not silent empty)
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  aggregateCohortTrades,
  buildCohortReport,
  type CohortAggregate,
} from "./cohort-report";
import type { SupabaseClient } from "@supabase/supabase-js";

// Internal type — re-derived here for fixture-construction purposes.
// Must stay in sync with the (private) CohortTrade interface in
// cohort-report.ts; if either changes, this re-derivation breaks at TS
// compile time and the test author notices.
interface FixtureTrade {
  date: Date;
  regime: string;
  prompt_version: string;
  side: string;
  conf_bucket: string;
  session_bucket: string;
  zone: string;
  exit_reason: string;
  r: number;
}

function trade(overrides: Partial<FixtureTrade> = {}): FixtureTrade {
  return {
    date: new Date("2026-06-22T12:00:00Z"),
    regime: "trend",
    prompt_version: "v5",
    side: "long",
    conf_bucket: "75+",
    session_bucket: "london(7-13)",
    zone: "discount",
    exit_reason: "take_profit",
    r: 1.0,
    ...overrides,
  };
}

const NOW = new Date("2026-06-22T00:00:00Z");
const DAY_MS = 86_400_000;

// ======================================================================
// aggregateCohortTrades — per-dimension aggregation
// ======================================================================

describe("aggregateCohortTrades — per-dimension aggregation", () => {
  it("empty trades → empty dimensions buckets / no flags / no candidates", () => {
    const r = aggregateCohortTrades([], { days: 14, minN: 5, now: NOW });
    // 7 dimensions, all empty
    expect(r.dimensions).toHaveLength(7);
    for (const d of r.dimensions) expect(d.buckets).toEqual([]);
    expect(r.decay_flags).toEqual([]);
    expect(r.shadow_gate_candidates).toEqual([]);
  });

  it("all-time per-dimension bucket counts add up to total", () => {
    const trades = [
      trade({ regime: "trend", side: "long" }),
      trade({ regime: "trend", side: "short" }),
      trade({ regime: "chop", side: "long" }),
    ];
    const r = aggregateCohortTrades(trades, { days: 14, minN: 5, now: NOW });
    const sideDim = r.dimensions.find((d) => d.label === "side");
    expect(sideDim).toBeDefined();
    const totalN = sideDim!.buckets.reduce((s, b) => s + b.stats.n, 0);
    expect(totalN).toBe(3);
  });

  it("buckets sorted by n descending (largest cohort first)", () => {
    const trades = [
      trade({ regime: "chop" }),
      trade({ regime: "trend" }),
      trade({ regime: "trend" }),
      trade({ regime: "trend" }),
      trade({ regime: "ranging" }),
      trade({ regime: "ranging" }),
    ];
    const r = aggregateCohortTrades(trades, { days: 14, minN: 5, now: NOW });
    const regime = r.dimensions.find((d) => d.label === "regime");
    expect(regime!.buckets.map((b) => b.value)).toEqual(["trend", "ranging", "chop"]);
    expect(regime!.buckets.map((b) => b.stats.n)).toEqual([3, 2, 1]);
  });

  it("WR computed as percentage 0-100 (not 0-1)", () => {
    const trades = [
      trade({ regime: "trend", r: 1.0 }), // win
      trade({ regime: "trend", r: 1.0 }), // win
      trade({ regime: "trend", r: -1.0 }), // loss
      trade({ regime: "trend", r: -1.0 }), // loss
    ];
    const r = aggregateCohortTrades(trades, { days: 14, minN: 5, now: NOW });
    const regime = r.dimensions.find((d) => d.label === "regime");
    const trend = regime!.buckets.find((b) => b.value === "trend");
    expect(trend!.stats.win_rate_pct).toBe(50);
    expect(trend!.stats.mean_r).toBe(0);
    expect(trend!.stats.sum_r).toBe(0);
  });
});

// ======================================================================
// Decay flags
// ======================================================================

describe("aggregateCohortTrades — decay flags", () => {
  // Build a fixture with 6 recent + 6 prior trades for a single regime.
  // Prior half-window: NOW-2*days to NOW-days (e.g. -28d to -14d)
  // Recent half-window: NOW-days to NOW (e.g. -14d to NOW)
  function buildHalves(priorRs: number[], recentRs: number[], days = 14): FixtureTrade[] {
    const out: FixtureTrade[] = [];
    for (const r of priorRs) {
      out.push(
        trade({
          regime: "trend",
          r,
          date: new Date(NOW.getTime() - (days + 1) * DAY_MS), // safely in prior half
        })
      );
    }
    for (const r of recentRs) {
      out.push(
        trade({
          regime: "trend",
          r,
          date: new Date(NOW.getTime() - 1 * DAY_MS), // safely in recent half
        })
      );
    }
    return out;
  }

  it("mean R drop ≥ 0.5 → flagged", () => {
    // Prior: mean R = 1.0; Recent: mean R = 0.4; drop = 0.6 ≥ 0.5 → flag
    const trades = buildHalves([1, 1, 1, 1, 1, 1], [0.4, 0.4, 0.4, 0.4, 0.4, 0.4]);
    const r = aggregateCohortTrades(trades, { days: 14, minN: 5, now: NOW });
    const f = r.decay_flags.find((x) => x.dimension === "regime" && x.value === "trend");
    expect(f).toBeDefined();
    expect(f!.mean_drop).toBeCloseTo(0.6, 5);
    expect(f!.recent_n).toBe(6);
    expect(f!.prior_n).toBe(6);
  });

  it("WR drop ≥ 20pp → flagged even when mean R drop alone wouldn't qualify", () => {
    // Prior: 5W/1L (83% WR); Recent: 3W/3L (50% WR); WR drop = 33pp ≥ 20
    // Mean R drop is small (we pick wins=+0.1 / losses=-0.1 to keep meanR similar)
    const trades = buildHalves(
      [0.1, 0.1, 0.1, 0.1, 0.1, -0.1], // 5W/1L mean 0.067
      [0.1, 0.1, 0.1, -0.1, -0.1, -0.1] // 3W/3L mean 0.0
    );
    const r = aggregateCohortTrades(trades, { days: 14, minN: 5, now: NOW });
    const f = r.decay_flags.find((x) => x.dimension === "regime" && x.value === "trend");
    expect(f).toBeDefined();
    expect(f!.wr_drop_pp).toBeGreaterThanOrEqual(20);
  });

  it("cohort below min_n in either half → NOT flagged (insufficient n)", () => {
    // Recent only has 4 trades — below min_n=5
    const trades = buildHalves([1, 1, 1, 1, 1, 1], [0.1, 0.1, 0.1, 0.1]);
    const r = aggregateCohortTrades(trades, { days: 14, minN: 5, now: NOW });
    expect(r.decay_flags).toEqual([]);
  });

  it("improving cohort (mean R rose) → NOT flagged", () => {
    // Prior: 0.1; Recent: 1.0 — improvement, never flag
    const trades = buildHalves(
      [0.1, 0.1, 0.1, 0.1, 0.1, 0.1],
      [1.0, 1.0, 1.0, 1.0, 1.0, 1.0]
    );
    const r = aggregateCohortTrades(trades, { days: 14, minN: 5, now: NOW });
    expect(r.decay_flags).toEqual([]);
  });
});

// ======================================================================
// Shadow-gate candidates
// ======================================================================

describe("aggregateCohortTrades — shadow-gate candidates", () => {
  it("n ≥ 8 + meanR ≤ −0.3 → candidate", () => {
    const trades = Array.from({ length: 8 }, () => trade({ regime: "chop", r: -0.5 }));
    const r = aggregateCohortTrades(trades, { days: 14, minN: 5, now: NOW });
    const c = r.shadow_gate_candidates.find((x) => x.dimension === "regime" && x.value === "chop");
    expect(c).toBeDefined();
    expect(c!.n).toBe(8);
    expect(c!.mean_r).toBeCloseTo(-0.5, 5);
    expect(c!.rationale).toContain("LOG-ONLY");
    expect(c!.rationale).toContain("scoped per algo+prompt_version");
  });

  it("n < 8 → not a candidate (even with negative meanR)", () => {
    const trades = Array.from({ length: 7 }, () => trade({ regime: "chop", r: -1.0 }));
    const r = aggregateCohortTrades(trades, { days: 14, minN: 5, now: NOW });
    expect(r.shadow_gate_candidates.find((x) => x.value === "chop")).toBeUndefined();
  });

  it("meanR > −0.3 → not a candidate (even with large n)", () => {
    const trades = Array.from({ length: 20 }, () => trade({ regime: "chop", r: -0.1 }));
    const r = aggregateCohortTrades(trades, { days: 14, minN: 5, now: NOW });
    expect(r.shadow_gate_candidates.find((x) => x.value === "chop")).toBeUndefined();
  });

  it("exit_reason dimension excluded (it's an outcome, not entry cohort)", () => {
    // 10 trades all stop_loss exits with meanR -1.0 — would qualify if
    // exit_reason were a candidate dimension. It MUST be excluded.
    const trades = Array.from({ length: 10 }, () => trade({ exit_reason: "stop_loss", r: -1.0 }));
    const r = aggregateCohortTrades(trades, { days: 14, minN: 5, now: NOW });
    expect(r.shadow_gate_candidates.find((x) => x.dimension === "exit_reason")).toBeUndefined();
  });
});

// ======================================================================
// buildCohortReport — query-layer smoke
// ======================================================================

interface SupabaseMockBag {
  supabase: SupabaseClient;
}

function makeSupabaseMock(opts: {
  decisionsData?: unknown[];
  decisionsError?: { message: string } | null;
  positionsData?: unknown[];
} = {}): SupabaseMockBag {
  const fromMock = vi.fn().mockImplementation((table: string) => {
    if (table === "llm_decisions") {
      // Chain: select.in.not.order[.eq]
      const builder: Record<string, unknown> = {};
      builder.in = vi.fn().mockReturnValue(builder);
      builder.not = vi.fn().mockReturnValue(builder);
      builder.order = vi.fn().mockReturnValue(builder);
      builder.eq = vi.fn().mockReturnValue(builder);
      builder.then = (onful?: (v: unknown) => unknown, onrej?: (e: unknown) => unknown) =>
        Promise.resolve({
          data: opts.decisionsData ?? [],
          error: opts.decisionsError ?? null,
        }).then(onful, onrej);
      return { select: vi.fn().mockReturnValue(builder) };
    }
    if (table === "paper_positions") {
      // Chain: select.in
      const builder: Record<string, unknown> = {};
      builder.in = vi.fn().mockImplementation(() => Promise.resolve({
        data: opts.positionsData ?? [],
        error: null,
      }));
      return { select: vi.fn().mockReturnValue(builder) };
    }
    throw new Error(`Unexpected table: ${table}`);
  });
  const stub = Object.create(null) as Record<string, unknown>;
  stub.from = fromMock;
  return { supabase: stub as unknown as SupabaseClient };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("buildCohortReport — query-layer smoke", () => {
  it("empty llm_decisions → CohortReport with total_trades=0 + empty sections", async () => {
    const { supabase } = makeSupabaseMock({ decisionsData: [] });
    const r = await buildCohortReport(supabase);
    expect(r.total_trades).toBe(0);
    expect(r.trades_skipped_no_r).toBe(0);
    expect(r.trades_with_zone_tags).toBe(0);
    expect(r.decay_flags).toEqual([]);
    expect(r.shadow_gate_candidates).toEqual([]);
    // Dimensions still listed (7 of them) but all empty
    expect(r.dimensions).toHaveLength(7);
    for (const d of r.dimensions) expect(d.buckets).toEqual([]);
    // Echo of options
    expect(r.days).toBe(14);
    expect(r.min_n).toBe(5);
    expect(r.source).toBe("live");
  });

  it("llm_decisions error → throws (loud failure, not silent empty)", async () => {
    const { supabase } = makeSupabaseMock({
      decisionsError: { message: "connection lost" },
    });
    await expect(buildCohortReport(supabase)).rejects.toThrow(/llm_decisions query failed/);
  });

  it("custom days + minN + source threaded into result echo", async () => {
    const { supabase } = makeSupabaseMock({ decisionsData: [] });
    const r = await buildCohortReport(supabase, { days: 30, minN: 10, source: "walk_forward" });
    expect(r.days).toBe(30);
    expect(r.min_n).toBe(10);
    expect(r.source).toBe("walk_forward");
  });
});

// ======================================================================
// Type-export contract — surface what's actually exported (catches
// accidental tree-shake of public types).
// ======================================================================

describe("cohort-report module — type-export surface", () => {
  it("CohortAggregate type-shape contract", () => {
    const a: CohortAggregate = { n: 0, wins: 0, win_rate_pct: 0, mean_r: 0, sum_r: 0 };
    expect(a.n).toBe(0);
  });
});
