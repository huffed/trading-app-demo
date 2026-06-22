/**
 * Unit tests for the consecutive-loss halt (CB.T1 pass 8, 2026-06-22).
 * Eighth test in `src/lib/scan/`. Tests `checkConsecutiveLossHalt` — a
 * pure DB-query helper that walks today's closed trades and decides
 * whether the algo's loss streak has hit its halt threshold.
 *
 * Coverage:
 *  - Threshold disabled (0 / negative) → no DB query, returns false
 *  - Empty result → streak:0, tripped:false
 *  - Win / break-even resets the streak (iteration breaks on first ≥0 pnl)
 *  - Significant losses accumulate streak
 *  - Micro losses (< 0.25R) skipped — don't break, don't count
 *  - Missing SL fields → loss counts (conservative fallback)
 *  - Degenerate stop (oneR=0) → loss counts (conservative fallback)
 *  - Streak hits threshold → tripped:true
 *  - Query was issued with correct table + filters + ordering
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { pnlInUsd } from "@/lib/constants/markets";
import { checkConsecutiveLossHalt } from "./consec-loss-halt";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/constants/markets", () => ({
  pnlInUsd: vi.fn(),
}));

const mockedPnlInUsd = vi.mocked(pnlInUsd);

// ---- Supabase chain mock for the consec-loss halt query. -------------
// Chain: .from(table).select(cols).eq(...).eq(...).gte(...).order(...).limit(...)
// The terminal .limit() awaits a {data, error} Promise.
type ClosedRowShape = {
  realized_pnl: number | null;
  closed_at: string;
  ticker: string | null;
  side: "long" | "short" | null;
  entry_price: number | null;
  stop_loss_price: number | null;
  quantity: number | null;
};

function makeSupabaseConsecMock(opts: {
  data?: ClosedRowShape[] | null;
  error?: { message: string } | null;
} = {}): {
  supabase: SupabaseClient;
  fromMock: ReturnType<typeof vi.fn>;
  capturedSelect: string | null;
  capturedEqCalls: Array<[string, unknown]>;
  capturedGte: [string, unknown] | null;
  capturedOrder: [string, { ascending: boolean }] | null;
  capturedLimit: number | null;
} {
  const capturedEqCalls: Array<[string, unknown]> = [];
  let capturedSelect: string | null = null;
  let capturedGte: [string, unknown] | null = null;
  let capturedOrder: [string, { ascending: boolean }] | null = null;
  let capturedLimit: number | null = null;

  const limitMock = vi.fn().mockImplementation((n: number) => {
    capturedLimit = n;
    return Promise.resolve({
      data: opts.data === undefined ? [] : opts.data,
      error: opts.error ?? null,
    });
  });
  const orderMock = vi.fn().mockImplementation((col: string, params: { ascending: boolean }) => {
    capturedOrder = [col, params];
    return { limit: limitMock };
  });
  const gteMock = vi.fn().mockImplementation((col: string, val: unknown) => {
    capturedGte = [col, val];
    return { order: orderMock };
  });
  const builder = {
    eq: vi.fn().mockImplementation((col: string, val: unknown) => {
      capturedEqCalls.push([col, val]);
      return builder;
    }),
    gte: gteMock,
  };
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
    get capturedGte() {
      return capturedGte;
    },
    get capturedOrder() {
      return capturedOrder;
    },
    get capturedLimit() {
      return capturedLimit;
    },
  };
}

// Default mock: pnlInUsd returns 10 — interpret this as "1R = $10".
// Test fixtures use realized_pnl in dollars; with 1R=$10, a loss of -10
// is exactly 1R adverse; -3 is 0.3R; -2 is 0.2R; -25 is 2.5R; etc.
beforeEach(() => {
  vi.clearAllMocks();
  mockedPnlInUsd.mockReturnValue(10);
});

// ---- Fixture builders. ------------------------------------------------
function makeClosedRow(overrides: Partial<ClosedRowShape> = {}): ClosedRowShape {
  return {
    realized_pnl: -10,
    closed_at: "2026-06-22T10:00:00Z",
    ticker: "XAU/USD",
    side: "long",
    entry_price: 3000,
    stop_loss_price: 2990,
    quantity: 1,
    ...overrides,
  };
}

// ======================================================================
// Threshold-disabled paths
// ======================================================================

describe("checkConsecutiveLossHalt — threshold disabled", () => {
  it("threshold=0 → returns tripped:false, streak:0, NO DB query", async () => {
    const { supabase, fromMock } = makeSupabaseConsecMock();
    const result = await checkConsecutiveLossHalt(supabase, "algo-1", 0);
    expect(result).toEqual({ tripped: false, streak: 0, threshold: 0 });
    expect(fromMock).not.toHaveBeenCalled();
  });

  it("negative threshold → returns tripped:false, streak:0, NO DB query (defensive)", async () => {
    const { supabase, fromMock } = makeSupabaseConsecMock();
    const result = await checkConsecutiveLossHalt(supabase, "algo-1", -1);
    expect(result).toEqual({ tripped: false, streak: 0, threshold: 0 });
    expect(fromMock).not.toHaveBeenCalled();
  });
});

// ======================================================================
// Streak counting
// ======================================================================

describe("checkConsecutiveLossHalt — streak counting", () => {
  it("empty result → streak:0, tripped:false", async () => {
    const { supabase } = makeSupabaseConsecMock({ data: [] });
    const result = await checkConsecutiveLossHalt(supabase, "algo-1", 3);
    expect(result).toEqual({ tripped: false, streak: 0, threshold: 3 });
  });

  it("3 significant losses → streak:3, tripped:true at threshold 3", async () => {
    const { supabase } = makeSupabaseConsecMock({
      data: [
        makeClosedRow({ realized_pnl: -10 }), // 1R loss
        makeClosedRow({ realized_pnl: -10 }),
        makeClosedRow({ realized_pnl: -10 }),
      ],
    });
    const result = await checkConsecutiveLossHalt(supabase, "algo-1", 3);
    expect(result).toEqual({ tripped: true, streak: 3, threshold: 3 });
  });

  it("2 significant losses → streak:2, tripped:false at threshold 3", async () => {
    const { supabase } = makeSupabaseConsecMock({
      data: [
        makeClosedRow({ realized_pnl: -10 }),
        makeClosedRow({ realized_pnl: -10 }),
      ],
    });
    const result = await checkConsecutiveLossHalt(supabase, "algo-1", 3);
    expect(result).toEqual({ tripped: false, streak: 2, threshold: 3 });
  });

  it("win breaks the streak at first ≥0 pnl (most-recent-first iteration)", async () => {
    const { supabase } = makeSupabaseConsecMock({
      data: [
        makeClosedRow({ realized_pnl: -10 }), // most recent: 1R loss → streak=1
        makeClosedRow({ realized_pnl: 5 }), // win → break loop
        makeClosedRow({ realized_pnl: -10 }), // would have counted but loop is done
        makeClosedRow({ realized_pnl: -10 }),
      ],
    });
    const result = await checkConsecutiveLossHalt(supabase, "algo-1", 3);
    expect(result.streak).toBe(1); // only the most-recent loss counts
  });

  it("break-even (pnl=0) breaks the streak just like a win", async () => {
    const { supabase } = makeSupabaseConsecMock({
      data: [
        makeClosedRow({ realized_pnl: -10 }),
        makeClosedRow({ realized_pnl: 0 }), // BE → break
        makeClosedRow({ realized_pnl: -10 }),
      ],
    });
    const result = await checkConsecutiveLossHalt(supabase, "algo-1", 3);
    expect(result.streak).toBe(1);
  });

  it("null realized_pnl is treated as 0 (BE) and breaks the streak", async () => {
    const { supabase } = makeSupabaseConsecMock({
      data: [
        makeClosedRow({ realized_pnl: -10 }),
        makeClosedRow({ realized_pnl: null }), // ?? 0 = BE → break
        makeClosedRow({ realized_pnl: -10 }),
      ],
    });
    const result = await checkConsecutiveLossHalt(supabase, "algo-1", 3);
    expect(result.streak).toBe(1);
  });
});

// ======================================================================
// Micro-loss skip semantics (R-magnitude filter)
// ======================================================================

describe("checkConsecutiveLossHalt — micro-loss skip semantics", () => {
  it("micro loss (< 0.25R) is SKIPPED — doesn't break, doesn't count", async () => {
    const { supabase } = makeSupabaseConsecMock({
      data: [
        makeClosedRow({ realized_pnl: -10 }), // 1R loss → streak=1
        makeClosedRow({ realized_pnl: -2 }), // 0.2R (< 0.25R threshold) → SKIP
        makeClosedRow({ realized_pnl: -10 }), // 1R loss → streak=2
      ],
    });
    const result = await checkConsecutiveLossHalt(supabase, "algo-1", 3);
    expect(result.streak).toBe(2);
  });

  it("loss at exactly 0.25R counts as significant (boundary)", async () => {
    const { supabase } = makeSupabaseConsecMock({
      data: [makeClosedRow({ realized_pnl: -2.5 })], // 0.25R / 1R = 0.25 exactly
    });
    const result = await checkConsecutiveLossHalt(supabase, "algo-1", 3);
    expect(result.streak).toBe(1); // boundary: >= 0.25 counts
  });

  it("loss at 0.24R does NOT count (just below boundary)", async () => {
    const { supabase } = makeSupabaseConsecMock({
      data: [makeClosedRow({ realized_pnl: -2.4 })], // 0.24R < 0.25R
    });
    const result = await checkConsecutiveLossHalt(supabase, "algo-1", 3);
    expect(result.streak).toBe(0);
  });
});

// ======================================================================
// Conservative fallback: missing SL fields count as significant
// ======================================================================

describe("checkConsecutiveLossHalt — conservative fallback for missing R math", () => {
  it("loss with stop_loss_price=null counts as significant (can't compute R)", async () => {
    const { supabase } = makeSupabaseConsecMock({
      data: [makeClosedRow({ realized_pnl: -1, stop_loss_price: null })],
    });
    const result = await checkConsecutiveLossHalt(supabase, "algo-1", 3);
    expect(result.streak).toBe(1); // micro -$1 would normally skip, but no SL → counted
  });

  it("loss with side=null counts as significant", async () => {
    const { supabase } = makeSupabaseConsecMock({
      data: [makeClosedRow({ realized_pnl: -1, side: null })],
    });
    expect((await checkConsecutiveLossHalt(supabase, "algo-1", 3)).streak).toBe(1);
  });

  it("loss with degenerate stop config (oneR=0) counts as significant", async () => {
    mockedPnlInUsd.mockReturnValue(0); // oneR = 0
    const { supabase } = makeSupabaseConsecMock({
      data: [makeClosedRow({ realized_pnl: -0.01 })], // any negative pnl
    });
    expect((await checkConsecutiveLossHalt(supabase, "algo-1", 3)).streak).toBe(1);
  });
});

// ======================================================================
// Query construction
// ======================================================================

describe("checkConsecutiveLossHalt — query construction", () => {
  it("queries paper_positions with correct filters + ordering + limit", async () => {
    const conf = makeSupabaseConsecMock({ data: [] });
    await checkConsecutiveLossHalt(conf.supabase, "algo-1", 3);
    expect(conf.fromMock).toHaveBeenCalledWith("paper_positions");
    // The select contains the 7 fields the consec-loss check needs
    expect(conf.capturedSelect).toContain("realized_pnl");
    expect(conf.capturedSelect).toContain("closed_at");
    expect(conf.capturedSelect).toContain("ticker");
    expect(conf.capturedSelect).toContain("side");
    expect(conf.capturedSelect).toContain("entry_price");
    expect(conf.capturedSelect).toContain("stop_loss_price");
    expect(conf.capturedSelect).toContain("quantity");
    // 2 .eq calls: algorithm_id + status=closed
    expect(conf.capturedEqCalls).toEqual([
      ["algorithm_id", "algo-1"],
      ["status", "closed"],
    ]);
    // .gte filters on closed_at >= today's UTC midnight ISO
    expect(conf.capturedGte?.[0]).toBe("closed_at");
    expect(typeof conf.capturedGte?.[1]).toBe("string");
    expect(conf.capturedGte?.[1]).toMatch(/T00:00:00\.000Z$/); // UTC midnight
    // Order: closed_at DESC (most-recent first)
    expect(conf.capturedOrder).toEqual(["closed_at", { ascending: false }]);
    // Generous cap: 50 rows
    expect(conf.capturedLimit).toBe(50);
  });

  it("startOfDay anchor is current UTC date (test by checking YYYY-MM-DD prefix)", async () => {
    const conf = makeSupabaseConsecMock({ data: [] });
    await checkConsecutiveLossHalt(conf.supabase, "algo-1", 3);
    const isoDate = conf.capturedGte?.[1] as string;
    const todayUtcPrefix = new Date().toISOString().slice(0, 10);
    expect(isoDate.startsWith(todayUtcPrefix)).toBe(true);
  });
});
