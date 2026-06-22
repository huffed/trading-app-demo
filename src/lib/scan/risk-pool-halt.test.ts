/**
 * Unit tests for the risk-pool halt (CB.T1 pass 10, 2026-06-22).
 * Tenth test in `src/lib/scan/`. Tests `checkRiskPoolHalt` — refuses
 * a new entry when COMBINED open exposure across all algos sharing a
 * broker connection (+ the proposed entry) would exceed the per-broker
 * combined-risk cap.
 *
 * New territory vs prior tests: TWO sequential supabase queries on
 * DIFFERENT tables (algorithms → algorithm_ids; paper_positions →
 * open-position rows). Mock dispatches by table name.
 *
 * Coverage (~17 tests):
 *  Cap clamping (3): below MIN → clamp, above MAX → clamp, within → unchanged
 *  No-algos shortcut (2): empty algo list → no positions query + proposed-only result
 *  Risk computation (4): single SL → pnlInUsd math; multi-position sum;
 *    missing-SL → 0 contribution; pct conversion
 *  Tripping boundary (3): combined > cap → trip; combined == cap → no trip;
 *    combined < cap → no trip
 *  Query construction (3): algorithms.select.eq filter; paper_positions
 *    .in(algorithm_id, ids).eq(status,open) chain; only runs if algoIds non-empty
 *  Edge cases (2): capital=0 → 0% currentRiskPct (no div-by-zero);
 *    default cap when caller omits the cap arg
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { pnlInUsd } from "@/lib/constants/markets";
import { checkRiskPoolHalt } from "./risk-pool-halt";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/constants/markets", () => ({
  pnlInUsd: vi.fn(),
}));

const mockedPnlInUsd = vi.mocked(pnlInUsd);

// ---- Supabase mock that dispatches by table name. ---------------------
// Two queries:
//  1. .from("algorithms").select("id").eq("broker_connection_id", id)
//     → terminal-thenable returning {data: [{id: "algo-1"}, ...]}
//  2. .from("paper_positions").select("...").in("algorithm_id", ids).eq("status", "open")
//     → terminal-thenable returning {data: [open position rows]}
type AlgoRow = { id: string };
type OpenRow = {
  ticker: string | null;
  side: "long" | "short" | null;
  entry_price: number | null;
  stop_loss_price: number | null;
  quantity: number | null;
  algorithm_id: string;
};

function makeSupabaseRiskPoolMock(opts: {
  algos?: AlgoRow[] | null;
  positions?: OpenRow[] | null;
} = {}): {
  supabase: SupabaseClient;
  fromMock: ReturnType<typeof vi.fn>;
  capturedAlgoFilters: Array<[string, unknown]>;
  capturedPositionFilters: { in?: [string, unknown]; eq?: [string, unknown] };
} {
  const capturedAlgoFilters: Array<[string, unknown]> = [];
  const capturedPositionFilters: { in?: [string, unknown]; eq?: [string, unknown] } = {};

  // Builder for algorithms query (eq is terminal-thenable).
  const algoResult = { data: opts.algos === undefined ? [] : opts.algos, error: null };
  const algoBuilder = Object.create(null) as Record<string, unknown>;
  algoBuilder.eq = vi.fn().mockImplementation((col: string, val: unknown) => {
    capturedAlgoFilters.push([col, val]);
    return algoBuilder;
  });
  algoBuilder.then = (
    onful?: (v: typeof algoResult) => unknown,
    onrej?: (e: unknown) => unknown
  ) => Promise.resolve(algoResult).then(onful, onrej);

  // Builder for paper_positions query (.in then .eq terminal-thenable).
  const positionsResult = {
    data: opts.positions === undefined ? [] : opts.positions,
    error: null,
  };
  const positionsBuilder = Object.create(null) as Record<string, unknown>;
  positionsBuilder.in = vi.fn().mockImplementation((col: string, val: unknown) => {
    capturedPositionFilters.in = [col, val];
    return positionsBuilder;
  });
  positionsBuilder.eq = vi.fn().mockImplementation((col: string, val: unknown) => {
    capturedPositionFilters.eq = [col, val];
    return positionsBuilder;
  });
  positionsBuilder.then = (
    onful?: (v: typeof positionsResult) => unknown,
    onrej?: (e: unknown) => unknown
  ) => Promise.resolve(positionsResult).then(onful, onrej);

  const fromMock = vi.fn().mockImplementation((table: string) => {
    if (table === "algorithms") {
      return { select: vi.fn().mockReturnValue(algoBuilder) };
    }
    if (table === "paper_positions") {
      return { select: vi.fn().mockReturnValue(positionsBuilder) };
    }
    throw new Error(`Unexpected table in test: ${table}`);
  });
  const supabaseStub = Object.create(null) as Record<string, unknown>;
  supabaseStub.from = fromMock;
  return {
    supabase: supabaseStub as unknown as SupabaseClient,
    fromMock,
    capturedAlgoFilters,
    capturedPositionFilters,
  };
}

// ---- Fixture helpers. -------------------------------------------------
function pos(overrides: Partial<OpenRow> = {}): OpenRow {
  return {
    ticker: "XAU/USD",
    side: "long",
    entry_price: 3000,
    stop_loss_price: 2990,
    quantity: 1,
    algorithm_id: "algo-1",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: each open position has $10 risk at SL (10pt × 1 quantity for XAUUSD)
  mockedPnlInUsd.mockReturnValue(-10);
});

// ======================================================================
// Cap clamping
// ======================================================================

describe("checkRiskPoolHalt — cap clamping bounds", () => {
  it("cap below MIN (0.5%) → clamped to MIN_CAP_PCT", async () => {
    const { supabase } = makeSupabaseRiskPoolMock();
    const r = await checkRiskPoolHalt(supabase, "broker-1", 10_000, 0, 0.1);
    expect(r.capPct).toBe(0.5);
  });

  it("cap above MAX (5.0%) → clamped to MAX_CAP_PCT (under FTMO DLL line)", async () => {
    const { supabase } = makeSupabaseRiskPoolMock();
    const r = await checkRiskPoolHalt(supabase, "broker-1", 10_000, 0, 100);
    expect(r.capPct).toBe(5.0);
  });

  it("cap within range [0.5, 5.0] → returned as-is", async () => {
    const { supabase } = makeSupabaseRiskPoolMock();
    expect((await checkRiskPoolHalt(supabase, "broker-1", 10_000, 0, 3)).capPct).toBe(3);
    expect((await checkRiskPoolHalt(supabase, "broker-1", 10_000, 0, 1)).capPct).toBe(1);
  });

  it("default cap when caller omits the cap arg → DEFAULT_COMBINED_RISK_CAP_PCT (3.0)", async () => {
    const { supabase } = makeSupabaseRiskPoolMock();
    const r = await checkRiskPoolHalt(supabase, "broker-1", 10_000, 0);
    expect(r.capPct).toBe(3.0);
  });
});

// ======================================================================
// No-algos-on-broker shortcut
// ======================================================================

describe("checkRiskPoolHalt — empty broker shortcut", () => {
  it("no algos on broker → returns proposed-only, NO paper_positions query", async () => {
    const conf = makeSupabaseRiskPoolMock({ algos: [] });
    const r = await checkRiskPoolHalt(conf.supabase, "broker-1", 10_000, 100);
    expect(r).toEqual({
      tripped: false,
      currentRiskPct: 0,
      proposedRiskPct: 1.0, // 100 / 10_000 × 100
      combinedRiskPct: 1.0,
      capPct: 3.0,
    });
    // paper_positions was NOT queried — short-circuit verified
    expect(conf.fromMock).toHaveBeenCalledTimes(1);
    expect(conf.fromMock).toHaveBeenCalledWith("algorithms");
  });

  it("empty algos + capital=0 → proposed pct also 0 (avoids div-by-zero)", async () => {
    const { supabase } = makeSupabaseRiskPoolMock({ algos: [] });
    const r = await checkRiskPoolHalt(supabase, "broker-1", 0, 100);
    expect(r.proposedRiskPct).toBe(0);
    expect(r.combinedRiskPct).toBe(0);
  });
});

// ======================================================================
// Risk computation
// ======================================================================

describe("checkRiskPoolHalt — risk computation", () => {
  it("single open position → currentRiskUsd from |pnlInUsd(SL math)|", async () => {
    mockedPnlInUsd.mockReturnValue(-15); // $15 loss at SL
    const { supabase } = makeSupabaseRiskPoolMock({
      algos: [{ id: "algo-1" }],
      positions: [pos()],
    });
    const r = await checkRiskPoolHalt(supabase, "broker-1", 10_000, 0);
    expect(r.currentRiskPct).toBe(0.15); // 15 / 10_000 × 100
    // pnlInUsd was called with the position's SL fields
    expect(mockedPnlInUsd).toHaveBeenCalledWith("XAU/USD", "long", 3000, 2990, 1);
  });

  it("multiple positions → sum of |pnlInUsd|", async () => {
    // 3 positions each $10 loss at SL → $30 combined risk
    mockedPnlInUsd.mockReturnValue(-10);
    const { supabase } = makeSupabaseRiskPoolMock({
      algos: [{ id: "algo-1" }, { id: "algo-2" }],
      positions: [pos(), pos({ algorithm_id: "algo-2" }), pos({ algorithm_id: "algo-2" })],
    });
    const r = await checkRiskPoolHalt(supabase, "broker-1", 10_000, 0);
    expect(r.currentRiskPct).toBe(0.3); // 30 / 10_000 × 100
  });

  it("position with missing SL fields → 0 contribution (conservative)", async () => {
    const { supabase } = makeSupabaseRiskPoolMock({
      algos: [{ id: "algo-1" }],
      positions: [
        pos(), // $10 risk
        pos({ stop_loss_price: null }), // missing SL → 0
        pos({ side: null }), // missing side → 0
        pos({ ticker: null }), // missing ticker → 0
        pos({ entry_price: null }), // missing entry → 0
        pos({ quantity: null }), // missing quantity → 0
      ],
    });
    const r = await checkRiskPoolHalt(supabase, "broker-1", 10_000, 0);
    // Only the first position contributed; the rest returned 0 from
    // positionRiskUsd's null-field guard.
    expect(r.currentRiskPct).toBe(0.1); // 10 / 10_000 × 100
  });

  it("combinedRiskPct = currentRiskPct + proposedRiskPct (additive)", async () => {
    mockedPnlInUsd.mockReturnValue(-10);
    const { supabase } = makeSupabaseRiskPoolMock({
      algos: [{ id: "algo-1" }],
      positions: [pos()], // $10 current risk
    });
    const r = await checkRiskPoolHalt(supabase, "broker-1", 10_000, 50); // $50 proposed
    expect(r.currentRiskPct).toBe(0.1); // 10 / 10k × 100
    expect(r.proposedRiskPct).toBe(0.5); // 50 / 10k × 100
    expect(r.combinedRiskPct).toBe(0.6);
  });
});

// ======================================================================
// Tripping boundary
// ======================================================================

describe("checkRiskPoolHalt — tripping boundary", () => {
  it("combined > cap → tripped:true", async () => {
    mockedPnlInUsd.mockReturnValue(-200); // each position $200 loss at SL
    const { supabase } = makeSupabaseRiskPoolMock({
      algos: [{ id: "algo-1" }],
      positions: [pos()], // current = 2%
    });
    // proposed $200 → 2%; combined = 4% > 3% cap
    const r = await checkRiskPoolHalt(supabase, "broker-1", 10_000, 200, 3);
    expect(r.tripped).toBe(true);
    expect(r.combinedRiskPct).toBe(4);
  });

  it("combined EXACTLY at cap → tripped:false (uses '>', not '>=')", async () => {
    mockedPnlInUsd.mockReturnValue(-150); // $150 = 1.5%
    const { supabase } = makeSupabaseRiskPoolMock({
      algos: [{ id: "algo-1" }],
      positions: [pos()], // current = 1.5%
    });
    // proposed $150 → 1.5%; combined = 3.0% exactly at cap
    const r = await checkRiskPoolHalt(supabase, "broker-1", 10_000, 150, 3);
    expect(r.tripped).toBe(false);
    expect(r.combinedRiskPct).toBe(3);
  });

  it("combined < cap → tripped:false", async () => {
    mockedPnlInUsd.mockReturnValue(-100);
    const { supabase } = makeSupabaseRiskPoolMock({
      algos: [{ id: "algo-1" }],
      positions: [pos()], // 1%
    });
    const r = await checkRiskPoolHalt(supabase, "broker-1", 10_000, 100, 3); // 1% + 1% = 2%
    expect(r.tripped).toBe(false);
    expect(r.combinedRiskPct).toBe(2);
  });
});

// ======================================================================
// Query construction
// ======================================================================

describe("checkRiskPoolHalt — query construction", () => {
  it("queries algorithms with broker_connection_id filter", async () => {
    const conf = makeSupabaseRiskPoolMock({ algos: [] });
    await checkRiskPoolHalt(conf.supabase, "broker-XYZ", 10_000, 0);
    expect(conf.capturedAlgoFilters).toEqual([["broker_connection_id", "broker-XYZ"]]);
  });

  it("queries paper_positions with .in(algorithm_id, algoIds) + .eq(status, open) ONLY when algos exist", async () => {
    const conf = makeSupabaseRiskPoolMock({
      algos: [{ id: "algo-1" }, { id: "algo-2" }],
      positions: [],
    });
    await checkRiskPoolHalt(conf.supabase, "broker-1", 10_000, 0);
    expect(conf.fromMock).toHaveBeenCalledWith("paper_positions");
    expect(conf.capturedPositionFilters.in).toEqual(["algorithm_id", ["algo-1", "algo-2"]]);
    expect(conf.capturedPositionFilters.eq).toEqual(["status", "open"]);
  });

  it("paper_positions query is SKIPPED when algos list is empty (short-circuit)", async () => {
    const conf = makeSupabaseRiskPoolMock({ algos: [] });
    await checkRiskPoolHalt(conf.supabase, "broker-1", 10_000, 0);
    expect(conf.fromMock).not.toHaveBeenCalledWith("paper_positions");
  });

  it("capital=0 with positions present → 0% currentRiskPct (avoids div-by-zero)", async () => {
    mockedPnlInUsd.mockReturnValue(-10);
    const { supabase } = makeSupabaseRiskPoolMock({
      algos: [{ id: "algo-1" }],
      positions: [pos()],
    });
    const r = await checkRiskPoolHalt(supabase, "broker-1", 0, 100);
    expect(r.currentRiskPct).toBe(0);
    expect(r.proposedRiskPct).toBe(0);
    expect(r.combinedRiskPct).toBe(0);
    expect(r.tripped).toBe(false);
  });
});
