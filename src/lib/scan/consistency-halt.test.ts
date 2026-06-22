/**
 * Unit tests for the FTMO consistency halt (CB.T1 pass 9, 2026-06-22).
 * Ninth test in `src/lib/scan/`. Tests `checkConsistencyHalt` — refuses
 * new entries when today's profit concentration exceeds the configured
 * ratio of lifetime profit (FTMO 40% standard rule).
 *
 * Coverage:
 *  Threshold-disabled paths (2 tests):
 *   - threshold=0 → tripped:false, no DB query
 *   - negative threshold → same defensive skip
 *
 *  Empty/zero-profit paths (4 tests):
 *   - Empty result → all zeros, not tripped
 *   - total_net ≤ 0 (losing or flat lifetime) → not tripped
 *   - today_net ≤ 0 (losing day) → not tripped
 *   - Both positive but small enough ratio → not tripped
 *
 *  Boundary + tripping (3 tests):
 *   - ratio at exactly threshold → tripped:true (>= comparison)
 *   - ratio just below threshold → tripped:false
 *   - ratio well above threshold → tripped:true
 *
 *  UTC partition + summation (3 tests):
 *   - today_net only sums rows where closed_at >= UTC midnight
 *   - total_net sums ALL closed rows
 *   - null realized_pnl is treated as 0
 *
 *  Query construction + threshold encoding (3 tests):
 *   - Queries paper_positions with algorithm_id + status='closed'
 *   - threshold returned as fraction (40 → 0.40)
 *   - Disabled path still encodes threshold in the returned object
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkConsistencyHalt } from "./consistency-halt";
import type { SupabaseClient } from "@supabase/supabase-js";

// ---- Supabase chain mock. ---------------------------------------------
// Chain: .from(t).select(c).eq(...).eq(...) — terminal .eq awaits.
type ClosedRowShape = {
  realized_pnl: number | null;
  closed_at: string;
};

function makeSupabaseConsistencyMock(opts: {
  data?: ClosedRowShape[] | null;
  error?: { message: string } | null;
} = {}): {
  supabase: SupabaseClient;
  fromMock: ReturnType<typeof vi.fn>;
  capturedSelect: string | null;
  capturedEqCalls: Array<[string, unknown]>;
} {
  const capturedEqCalls: Array<[string, unknown]> = [];
  let capturedSelect: string | null = null;

  // The builder must be both chainable (.eq returns builder) AND awaitable
  // (terminal .eq await produces {data, error}). Standard supabase-js
  // PostgrestFilterBuilder pattern: implement .then() so the builder IS
  // a thenable, and have .eq() always return the same builder. The test
  // calls .eq twice; on either await, we resolve the result.
  const result = {
    data: opts.data === undefined ? [] : opts.data,
    error: opts.error ?? null,
  };
  const builder = Object.create(null) as Record<string, unknown>;
  builder.eq = vi.fn().mockImplementation((col: string, val: unknown) => {
    capturedEqCalls.push([col, val]);
    return builder;
  });
  builder.then = (
    onfulfilled?: (v: typeof result) => unknown,
    onrejected?: (e: unknown) => unknown
  ) => Promise.resolve(result).then(onfulfilled, onrejected);

  const selectMock = vi.fn().mockImplementation((cols: string) => {
    capturedSelect = cols;
    return builder;
  });
  const fromMock = vi.fn().mockReturnValue({ select: selectMock });
  const supabaseStub = Object.create(null) as Record<string, unknown>;
  supabaseStub.from = fromMock;
  return {
    supabase: supabaseStub as unknown as SupabaseClient,
    fromMock,
    get capturedSelect() {
      return capturedSelect;
    },
    capturedEqCalls,
  };
}

// ---- Fixture helpers. -------------------------------------------------
const TODAY_ISO = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
const TODAY_TS = `${TODAY_ISO}T12:00:00.000Z`; // mid-day today (after UTC midnight)
const YESTERDAY_TS = (() => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString();
})();

function row(pnl: number | null, closed: string = TODAY_TS): ClosedRowShape {
  return { realized_pnl: pnl, closed_at: closed };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ======================================================================
// Threshold-disabled paths
// ======================================================================

describe("checkConsistencyHalt — threshold disabled", () => {
  it("threshold=0 → returns disabled (tripped:false, all zero, threshold:0), NO DB query", async () => {
    const { supabase, fromMock } = makeSupabaseConsistencyMock();
    const result = await checkConsistencyHalt(supabase, "algo-1", 0);
    expect(result).toEqual({
      tripped: false,
      today_net: 0,
      total_net: 0,
      ratio: 0,
      threshold: 0,
    });
    expect(fromMock).not.toHaveBeenCalled();
  });

  it("negative threshold → returns disabled, NO DB query (defensive)", async () => {
    const { supabase, fromMock } = makeSupabaseConsistencyMock();
    const result = await checkConsistencyHalt(supabase, "algo-1", -10);
    expect(result.tripped).toBe(false);
    expect(fromMock).not.toHaveBeenCalled();
  });
});

// ======================================================================
// Empty / zero-profit / not-tripped paths
// ======================================================================

describe("checkConsistencyHalt — non-tripped paths", () => {
  it("empty result → all zero, not tripped, threshold encoded as fraction", async () => {
    const { supabase } = makeSupabaseConsistencyMock({ data: [] });
    const result = await checkConsistencyHalt(supabase, "algo-1", 40);
    expect(result).toEqual({
      tripped: false,
      today_net: 0,
      total_net: 0,
      ratio: 0,
      threshold: 0.4,
    });
  });

  it("total_net ≤ 0 (losing or flat lifetime) → not tripped, ratio:0", async () => {
    const { supabase } = makeSupabaseConsistencyMock({
      data: [
        row(100, TODAY_TS), // today's win
        row(-200, YESTERDAY_TS), // yesterday's loss (cancels lifetime)
      ],
    });
    const result = await checkConsistencyHalt(supabase, "algo-1", 40);
    expect(result.tripped).toBe(false);
    expect(result.today_net).toBe(100);
    expect(result.total_net).toBe(-100);
    expect(result.ratio).toBe(0); // ratio set to 0 explicitly when total_net ≤ 0
  });

  it("today_net ≤ 0 (losing day) → not tripped, ratio:0", async () => {
    const { supabase } = makeSupabaseConsistencyMock({
      data: [
        row(-50, TODAY_TS), // losing day
        row(200, YESTERDAY_TS), // lifetime positive
      ],
    });
    const result = await checkConsistencyHalt(supabase, "algo-1", 40);
    expect(result.tripped).toBe(false);
    expect(result.today_net).toBe(-50);
    expect(result.total_net).toBe(150);
    expect(result.ratio).toBe(0);
  });

  it("both positive but ratio below threshold → not tripped, returns computed ratio", async () => {
    const { supabase } = makeSupabaseConsistencyMock({
      data: [
        row(50, TODAY_TS), // today's $50 win
        row(200, YESTERDAY_TS), // lifetime $250 total, today is 20%
      ],
    });
    const result = await checkConsistencyHalt(supabase, "algo-1", 40);
    expect(result.tripped).toBe(false);
    expect(result.today_net).toBe(50);
    expect(result.total_net).toBe(250);
    expect(result.ratio).toBe(0.2);
  });
});

// ======================================================================
// Boundary + tripping
// ======================================================================

describe("checkConsistencyHalt — tripping behaviour", () => {
  it("ratio EXACTLY at threshold → tripped:true (>= comparison, not >)", async () => {
    const { supabase } = makeSupabaseConsistencyMock({
      data: [
        row(40, TODAY_TS),
        row(60, YESTERDAY_TS), // lifetime $100, today is 40% exactly
      ],
    });
    const result = await checkConsistencyHalt(supabase, "algo-1", 40);
    expect(result.tripped).toBe(true);
    expect(result.ratio).toBe(0.4);
  });

  it("ratio just below threshold → tripped:false", async () => {
    const { supabase } = makeSupabaseConsistencyMock({
      data: [
        row(39, TODAY_TS),
        row(61, YESTERDAY_TS), // 39% — just below 40%
      ],
    });
    const result = await checkConsistencyHalt(supabase, "algo-1", 40);
    expect(result.tripped).toBe(false);
    expect(result.ratio).toBe(0.39);
  });

  it("ratio well above threshold → tripped:true", async () => {
    const { supabase } = makeSupabaseConsistencyMock({
      data: [
        row(500, TODAY_TS),
        row(100, YESTERDAY_TS), // lifetime $600, today is ~83%
      ],
    });
    const result = await checkConsistencyHalt(supabase, "algo-1", 40);
    expect(result.tripped).toBe(true);
    expect(result.ratio).toBeCloseTo(0.833, 2);
  });
});

// ======================================================================
// UTC partition + summation semantics
// ======================================================================

describe("checkConsistencyHalt — UTC partition + summation", () => {
  it("only rows with closed_at >= UTC midnight TODAY count toward today_net", async () => {
    const { supabase } = makeSupabaseConsistencyMock({
      data: [
        row(100, TODAY_TS), // today
        row(50, `${TODAY_ISO}T00:00:00.000Z`), // exactly UTC midnight (boundary inclusive)
        row(75, YESTERDAY_TS), // yesterday — counted in total only
      ],
    });
    const result = await checkConsistencyHalt(supabase, "algo-1", 40);
    expect(result.today_net).toBe(150); // 100 + 50 (midnight is inclusive via >=)
    expect(result.total_net).toBe(225); // 100 + 50 + 75
  });

  it("total_net sums ALL closed rows regardless of date", async () => {
    const { supabase } = makeSupabaseConsistencyMock({
      data: [
        row(10, TODAY_TS),
        row(20, YESTERDAY_TS),
        row(30, "2026-01-01T00:00:00.000Z"), // way old
        row(-15, "2025-12-15T00:00:00.000Z"),
      ],
    });
    const result = await checkConsistencyHalt(supabase, "algo-1", 40);
    expect(result.total_net).toBe(45); // 10 + 20 + 30 - 15
    expect(result.today_net).toBe(10);
  });

  it("null realized_pnl treated as 0 (?? coercion) in both sums", async () => {
    const { supabase } = makeSupabaseConsistencyMock({
      data: [
        row(null, TODAY_TS), // null today
        row(null, YESTERDAY_TS), // null past
        row(100, TODAY_TS),
        row(50, YESTERDAY_TS),
      ],
    });
    const result = await checkConsistencyHalt(supabase, "algo-1", 40);
    expect(result.today_net).toBe(100);
    expect(result.total_net).toBe(150);
  });
});

// ======================================================================
// Query construction + threshold encoding
// ======================================================================

describe("checkConsistencyHalt — query construction + threshold encoding", () => {
  it("queries paper_positions with algorithm_id + status='closed' filters", async () => {
    const conf = makeSupabaseConsistencyMock({ data: [] });
    await checkConsistencyHalt(conf.supabase, "algo-XYZ", 40);
    expect(conf.fromMock).toHaveBeenCalledWith("paper_positions");
    expect(conf.capturedSelect).toBe("realized_pnl, closed_at");
    expect(conf.capturedEqCalls).toEqual([
      ["algorithm_id", "algo-XYZ"],
      ["status", "closed"],
    ]);
  });

  it("threshold returned as fraction (40 → 0.40, 50 → 0.50)", async () => {
    const { supabase } = makeSupabaseConsistencyMock({ data: [] });
    expect((await checkConsistencyHalt(supabase, "algo-1", 40)).threshold).toBe(0.4);
    expect((await checkConsistencyHalt(supabase, "algo-1", 50)).threshold).toBe(0.5);
    expect((await checkConsistencyHalt(supabase, "algo-1", 25)).threshold).toBe(0.25);
  });

  it("disabled path (threshold=0) returns threshold:0 in the result object", async () => {
    const { supabase } = makeSupabaseConsistencyMock();
    const result = await checkConsistencyHalt(supabase, "algo-1", 0);
    expect(result.threshold).toBe(0);
  });
});
