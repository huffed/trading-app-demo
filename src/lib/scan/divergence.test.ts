/**
 * Unit tests for divergence (CB.T1 pass 17, 2026-06-22).
 * Seventeenth test in `src/lib/scan/`. Cumulative paper-vs-broker
 * divergence kill switch — locks the contract that live-execution.ts
 * depends on (we mocked these helpers in pass 16; now lock the
 * internals so any contract drift is caught immediately).
 *
 * Coverage (~18 tests):
 *  checkDivergenceKill:
 *   - Sample count BELOW window_trades → {tripped:false, avgBps:NaN, samples}
 *     (small-sample noise rule — refuse to halt on insufficient data)
 *   - Sample count = window_trades, avg below threshold → not tripped
 *   - Sample count = window_trades, avg above threshold → tripped
 *   - avg EXACTLY at threshold → NOT tripped (strict > comparison, not >=)
 *   - avgBps math: |fill-entry|/entry × 10000 = bps; absolute value used
 *     (under-fill and over-fill both contribute equally — sign-blind)
 *   - Empty data → samples=0 → tripped:false
 *   - Defensive: row with broker_fill_price null in math loop skipped
 *   - Defensive: row with entry_price ≤ 0 skipped (div-by-zero guard)
 *   - Query construction: from("paper_positions"), select fields, eq
 *     algorithm_id, not broker_fill_price is null, order opened_at desc,
 *     limit window_trades
 *
 *  haltAlgorithmForDivergence:
 *   - UPDATE algorithms set live_trading_enabled=false WHERE id=...
 *   - logActivity called with "divergence_halt" event_type
 *   - Details: avg_bps rounded to 2 decimals + threshold_bps + samples +
 *     window_trades (operator-facing audit format)
 *   - No ticker (algorithm-level event, not position-level)
 *   - Update fires BEFORE log (order-of-operations: halt first, audit
 *     second — so concurrent ticks see the halt immediately)
 *
 *  Contract-drift guards (pass 17):
 *   - DivergenceCheckResult shape is {tripped, avgBps, samples} — NOT
 *     {tripped, avg_bps, n, threshold_bps}. Lock the exact field names.
 *   - rule shape is {max_avg_bps, window_trades} — both fields present.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkDivergenceKill,
  haltAlgorithmForDivergence,
  type DivergenceCheckResult,
} from "./divergence";
import { logActivity } from "./helpers";
import type { SupabaseClient } from "@supabase/supabase-js";

// ---- Mocks. -----------------------------------------------------------
vi.mock("./helpers", () => ({
  logActivity: vi.fn(),
}));

const mockedLogActivity = vi.mocked(logActivity);

// ---- Supabase mock for checkDivergenceKill query. ---------------------
// Chain: from(t).select(c).eq(c,v).not(c,o,v).order(c,opts).limit(n)
// Terminal .limit awaits {data, error}.
interface CheckQueryCapture {
  selectCols: string | null;
  eqCalls: Array<[string, unknown]>;
  notCalls: Array<[string, string, unknown]>;
  orderCalls: Array<[string, unknown]>;
  limitCalls: number[];
}

function makeCheckQueryMock(
  data: Array<{ entry_price: number; broker_fill_price: number | null }> | null
): { supabase: SupabaseClient; capture: CheckQueryCapture; fromMock: ReturnType<typeof vi.fn> } {
  const capture: CheckQueryCapture = {
    selectCols: null,
    eqCalls: [],
    notCalls: [],
    orderCalls: [],
    limitCalls: [],
  };
  const result = { data, error: null };

  const builder = Object.create(null) as Record<string, unknown>;
  builder.eq = vi.fn().mockImplementation((col: string, val: unknown) => {
    capture.eqCalls.push([col, val]);
    return builder;
  });
  builder.not = vi.fn().mockImplementation((col: string, op: string, val: unknown) => {
    capture.notCalls.push([col, op, val]);
    return builder;
  });
  builder.order = vi.fn().mockImplementation((col: string, opts: unknown) => {
    capture.orderCalls.push([col, opts]);
    return builder;
  });
  builder.limit = vi.fn().mockImplementation((n: number) => {
    capture.limitCalls.push(n);
    return Promise.resolve(result);
  });

  const select = vi.fn().mockImplementation((cols: string) => {
    capture.selectCols = cols;
    return builder;
  });
  const fromMock = vi.fn().mockReturnValue({ select });
  const supabaseStub = Object.create(null) as Record<string, unknown>;
  supabaseStub.from = fromMock;
  return {
    supabase: supabaseStub as unknown as SupabaseClient,
    capture,
    fromMock,
  };
}

// ---- Supabase mock for haltAlgorithmForDivergence (algorithms.update). ----
function makeHaltMock(): {
  supabase: SupabaseClient;
  updatePayloads: Array<Record<string, unknown>>;
  updateEqCalls: Array<Array<[string, unknown]>>;
  callOrder: string[];
} {
  const updatePayloads: Array<Record<string, unknown>> = [];
  const updateEqCalls: Array<Array<[string, unknown]>> = [];
  const callOrder: string[] = [];

  const fromMock = vi.fn((table: string) => {
    if (table !== "algorithms") throw new Error(`Unexpected table: ${table}`);
    const update = vi.fn().mockImplementation((payload: Record<string, unknown>) => {
      const eqCalls: Array<[string, unknown]> = [];
      const result = { data: null, error: null };
      const builder = Object.create(null) as Record<string, unknown>;
      builder.eq = vi.fn().mockImplementation((col: string, val: unknown) => {
        eqCalls.push([col, val]);
        callOrder.push("update_eq");
        return Promise.resolve(result);
      });
      updatePayloads.push(payload);
      updateEqCalls.push(eqCalls);
      return builder;
    });
    return { update };
  });
  // logActivity is mocked, so we instrument its call order by spying
  mockedLogActivity.mockImplementation(async () => {
    callOrder.push("log_activity");
  });

  const stub = Object.create(null) as Record<string, unknown>;
  stub.from = fromMock;
  return {
    supabase: stub as unknown as SupabaseClient,
    updatePayloads,
    updateEqCalls,
    callOrder,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedLogActivity.mockResolvedValue(undefined);
});

// ======================================================================
// checkDivergenceKill — sample-size + threshold semantics
// ======================================================================

describe("checkDivergenceKill — sample-size + threshold", () => {
  it("samples < window_trades → {tripped:false, avgBps:NaN, samples} (small-sample noise rule)", async () => {
    // 5 rows but window_trades=10 → insufficient sample
    const { supabase } = makeCheckQueryMock(
      Array.from({ length: 5 }, () => ({ entry_price: 3000, broker_fill_price: 3100 }))
    );
    const r = await checkDivergenceKill(supabase, "algo-1", {
      max_avg_bps: 20,
      window_trades: 10,
    });
    expect(r.tripped).toBe(false);
    expect(Number.isNaN(r.avgBps)).toBe(true);
    expect(r.samples).toBe(5);
  });

  it("samples = window_trades, avg BELOW threshold → not tripped", async () => {
    // 10 rows, divergence 0 bps each → avg 0 < 20 threshold
    const { supabase } = makeCheckQueryMock(
      Array.from({ length: 10 }, () => ({ entry_price: 3000, broker_fill_price: 3000 }))
    );
    const r = await checkDivergenceKill(supabase, "algo-1", {
      max_avg_bps: 20,
      window_trades: 10,
    });
    expect(r.tripped).toBe(false);
    expect(r.avgBps).toBe(0);
    expect(r.samples).toBe(10);
  });

  it("samples = window_trades, avg ABOVE threshold → tripped", async () => {
    // 10 rows, fill 3010 vs entry 3000 → bps = 10/3000 × 10000 ≈ 33.33 bps each
    // avg = 33.33 > 20 threshold → tripped
    const { supabase } = makeCheckQueryMock(
      Array.from({ length: 10 }, () => ({ entry_price: 3000, broker_fill_price: 3010 }))
    );
    const r = await checkDivergenceKill(supabase, "algo-1", {
      max_avg_bps: 20,
      window_trades: 10,
    });
    expect(r.tripped).toBe(true);
    expect(r.avgBps).toBeCloseTo(33.33, 1);
  });

  it("avg EXACTLY at threshold → NOT tripped (strict > comparison, not >=)", async () => {
    // Construct rows where bps = 20.0 exactly: fill 3006 vs entry 3000 → 6/3000 × 10000 = 20 bps
    const { supabase } = makeCheckQueryMock(
      Array.from({ length: 10 }, () => ({ entry_price: 3000, broker_fill_price: 3006 }))
    );
    const r = await checkDivergenceKill(supabase, "algo-1", {
      max_avg_bps: 20,
      window_trades: 10,
    });
    expect(r.tripped).toBe(false); // 20 > 20 is false
    expect(r.avgBps).toBeCloseTo(20, 6);
  });
});

describe("checkDivergenceKill — bps math", () => {
  it("avgBps = |fill - entry| / entry × 10000 (correct formula)", async () => {
    // Single row at exactly 100 bps divergence: entry=100, fill=101 → |1|/100×10000 = 100 bps
    const { supabase } = makeCheckQueryMock(
      Array.from({ length: 5 }, () => ({ entry_price: 100, broker_fill_price: 101 }))
    );
    const r = await checkDivergenceKill(supabase, "algo-1", {
      max_avg_bps: 50,
      window_trades: 5,
    });
    expect(r.avgBps).toBeCloseTo(100, 6);
  });

  it("absolute value: under-fill and over-fill both contribute positively (sign-blind)", async () => {
    // Mix of over and under fills, same magnitude — average should be the magnitude, not zero
    const { supabase } = makeCheckQueryMock([
      { entry_price: 3000, broker_fill_price: 3010 }, // +33.33 bps
      { entry_price: 3000, broker_fill_price: 2990 }, // -33.33 bps in raw, +33.33 abs
      { entry_price: 3000, broker_fill_price: 3010 }, // +33.33
      { entry_price: 3000, broker_fill_price: 2990 }, // +33.33 abs
    ]);
    const r = await checkDivergenceKill(supabase, "algo-1", {
      max_avg_bps: 20,
      window_trades: 4,
    });
    expect(r.avgBps).toBeCloseTo(33.33, 1); // NOT 0 (sign-blind)
    expect(r.tripped).toBe(true);
  });
});

describe("checkDivergenceKill — defensive guards", () => {
  it("empty data → samples=0 → tripped:false (no division on empty set)", async () => {
    const { supabase } = makeCheckQueryMock([]);
    const r = await checkDivergenceKill(supabase, "algo-1", {
      max_avg_bps: 20,
      window_trades: 10,
    });
    expect(r.tripped).toBe(false);
    expect(r.samples).toBe(0);
    expect(Number.isNaN(r.avgBps)).toBe(true);
  });

  it("null data → treated as empty set (defensive ?? [] fallback)", async () => {
    const { supabase } = makeCheckQueryMock(null);
    const r = await checkDivergenceKill(supabase, "algo-1", {
      max_avg_bps: 20,
      window_trades: 10,
    });
    expect(r.tripped).toBe(false);
    expect(r.samples).toBe(0);
  });

  it("row with broker_fill_price=null in math loop SKIPPED (defensive even though .not query filters)", async () => {
    // Some rows have null fill (shouldn't happen with the .not query, but defensive)
    const rows = [
      { entry_price: 3000, broker_fill_price: 3010 }, // 33.33 bps
      { entry_price: 3000, broker_fill_price: null }, // skipped
      { entry_price: 3000, broker_fill_price: 3010 }, // 33.33 bps
      { entry_price: 3000, broker_fill_price: 3010 }, // 33.33 bps
    ];
    const { supabase } = makeCheckQueryMock(rows);
    const r = await checkDivergenceKill(supabase, "algo-1", {
      max_avg_bps: 20,
      window_trades: 4,
    });
    // Sum = 3 × 33.33 = 100; divided by samples=4 (NOT filtered count): 25 bps
    // This is the documented behaviour — denominator is rows.length, not contributing-rows
    expect(r.avgBps).toBeCloseTo(25, 1);
    expect(r.samples).toBe(4);
  });

  it("row with entry_price=0 SKIPPED in math loop (div-by-zero guard)", async () => {
    const rows = [
      { entry_price: 3000, broker_fill_price: 3010 }, // 33.33 bps
      { entry_price: 0, broker_fill_price: 100 }, // would div by 0 — skipped
      { entry_price: 3000, broker_fill_price: 3010 }, // 33.33
      { entry_price: 3000, broker_fill_price: 3010 }, // 33.33
    ];
    const { supabase } = makeCheckQueryMock(rows);
    const r = await checkDivergenceKill(supabase, "algo-1", {
      max_avg_bps: 20,
      window_trades: 4,
    });
    expect(Number.isNaN(r.avgBps)).toBe(false); // No NaN/Infinity from div-by-zero
    expect(r.samples).toBe(4);
  });

  it("row with entry_price<0 (impossible but defensive) also SKIPPED", async () => {
    const rows = [
      { entry_price: 3000, broker_fill_price: 3010 },
      { entry_price: -100, broker_fill_price: 100 }, // negative entry — skipped (≤ 0 guard)
      { entry_price: 3000, broker_fill_price: 3010 },
      { entry_price: 3000, broker_fill_price: 3010 },
    ];
    const { supabase } = makeCheckQueryMock(rows);
    const r = await checkDivergenceKill(supabase, "algo-1", {
      max_avg_bps: 20,
      window_trades: 4,
    });
    expect(Number.isNaN(r.avgBps)).toBe(false);
  });
});

describe("checkDivergenceKill — query construction", () => {
  it("queries paper_positions with correct filters + ordering", async () => {
    const { supabase, capture, fromMock } = makeCheckQueryMock([]);
    await checkDivergenceKill(supabase, "algo-XYZ", {
      max_avg_bps: 20,
      window_trades: 15,
    });
    expect(fromMock).toHaveBeenCalledWith("paper_positions");
    expect(capture.selectCols).toBe("entry_price, broker_fill_price");
    expect(capture.eqCalls).toEqual([["algorithm_id", "algo-XYZ"]]);
    expect(capture.notCalls).toEqual([["broker_fill_price", "is", null]]);
    expect(capture.orderCalls).toEqual([["opened_at", { ascending: false }]]);
    expect(capture.limitCalls).toEqual([15]); // matches window_trades
  });

  it("window_trades=20 → LIMIT 20 in query (config plumbed through)", async () => {
    const { supabase, capture } = makeCheckQueryMock([]);
    await checkDivergenceKill(supabase, "algo-1", {
      max_avg_bps: 5,
      window_trades: 20,
    });
    expect(capture.limitCalls).toEqual([20]);
  });
});

// ======================================================================
// haltAlgorithmForDivergence
// ======================================================================

describe("haltAlgorithmForDivergence", () => {
  const sampleResult: DivergenceCheckResult = {
    tripped: true,
    avgBps: 27.346, // will round to 27.35 in payload
    samples: 20,
  };
  const sampleRule = { max_avg_bps: 20, window_trades: 20 };

  it("UPDATE algorithms set live_trading_enabled=false WHERE id=<algoId>", async () => {
    const { supabase, updatePayloads, updateEqCalls } = makeHaltMock();
    await haltAlgorithmForDivergence(supabase, "user-1", "algo-XYZ", sampleResult, sampleRule);
    expect(updatePayloads[0]).toEqual({ live_trading_enabled: false });
    expect(updateEqCalls[0]).toEqual([["id", "algo-XYZ"]]);
  });

  it("logActivity called with event_type='divergence_halt'", async () => {
    const { supabase } = makeHaltMock();
    await haltAlgorithmForDivergence(supabase, "user-1", "algo-1", sampleResult, sampleRule);
    expect(mockedLogActivity.mock.calls[0][2].event_type).toBe("divergence_halt");
  });

  it("activity details: avg_bps rounded to 2 decimals + threshold + samples + window_trades", async () => {
    const { supabase } = makeHaltMock();
    await haltAlgorithmForDivergence(supabase, "user-1", "algo-1", sampleResult, sampleRule);
    expect(mockedLogActivity.mock.calls[0][2].details).toEqual({
      avg_bps: 27.35, // rounded from 27.346
      threshold_bps: 20,
      samples: 20,
      window_trades: 20,
    });
  });

  it("logActivity carries algorithm_id but NO ticker (algorithm-level event)", async () => {
    const { supabase } = makeHaltMock();
    await haltAlgorithmForDivergence(supabase, "user-1", "algo-XYZ", sampleResult, sampleRule);
    const entry = mockedLogActivity.mock.calls[0][2];
    expect(entry.algorithm_id).toBe("algo-XYZ");
    expect(entry.ticker).toBeUndefined();
    expect(entry.position_id).toBeUndefined();
  });

  it("UPDATE runs BEFORE logActivity (halt first, audit second — concurrent ticks see halt immediately)", async () => {
    const { supabase, callOrder } = makeHaltMock();
    await haltAlgorithmForDivergence(supabase, "user-1", "algo-1", sampleResult, sampleRule);
    // Both should fire; update_eq must come before log_activity
    expect(callOrder).toEqual(["update_eq", "log_activity"]);
  });
});

// ======================================================================
// Contract-drift guards
// ======================================================================

describe("divergence — contract-drift guards (locks live-execution mock contract)", () => {
  it("DivergenceCheckResult shape is {tripped, avgBps, samples} — NOT {avg_bps, n, threshold_bps}", async () => {
    const { supabase } = makeCheckQueryMock([
      { entry_price: 3000, broker_fill_price: 3010 },
      { entry_price: 3000, broker_fill_price: 3010 },
    ]);
    const r = await checkDivergenceKill(supabase, "algo-1", {
      max_avg_bps: 20,
      window_trades: 2,
    });
    // Explicit field-name lock: drift-detector. Any rename in source
    // breaks live-execution.test.ts pass-16 mock + this assertion both.
    expect(Object.keys(r).sort()).toEqual(["avgBps", "samples", "tripped"]);
    // Wrong-name guards (would have caught the pass-16 mock drift):
    expect((r as unknown as { avg_bps?: number }).avg_bps).toBeUndefined();
    expect((r as unknown as { n?: number }).n).toBeUndefined();
    expect((r as unknown as { threshold_bps?: number }).threshold_bps).toBeUndefined();
  });

  it("rule shape: max_avg_bps + window_trades both required + plumbed through", async () => {
    const { supabase, capture } = makeCheckQueryMock([]);
    await checkDivergenceKill(supabase, "algo-1", {
      max_avg_bps: 25,
      window_trades: 30,
    });
    // window_trades → limit
    expect(capture.limitCalls).toEqual([30]);
    // max_avg_bps is read inside the comparison — verified via threshold tests above
  });
});
