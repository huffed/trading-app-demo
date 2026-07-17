/**
 * Unit tests for the portfolio-level DLL halt (CB.T1 pass 11,
 * 2026-06-22). Eleventh test in `src/lib/scan/`. Tests both exports:
 *  - checkPortfolioHalt (parallel-query verdict)
 *  - executePortfolioHalt (per-algo flatten + disable + log)
 *
 * New territory: TWO PARALLEL supabase queries on the same table with
 * different selects + filters; second function performs side effects
 * (flatten + update + log) for EACH algoId in a loop.
 *
 * Coverage (~16 tests):
 *  checkPortfolioHalt — null-return paths (2): no DLL config, empty algos
 *  checkPortfolioHalt — sum computation (3): realized over today's closed,
 *    unrealized over open, null pnl coerced to 0
 *  checkPortfolioHalt — verdict math (4): pnl_pct computation, threshold
 *    derivation, tripped boundary, capital=0 div-by-zero guard
 *  checkPortfolioHalt — query construction (3): closed query filters,
 *    open query filters, both use same table
 *  executePortfolioHalt — side-effect loop (3): flatten called per algo,
 *    algorithms.update sets live_trading_enabled=false, logActivity
 *    payload contains portfolio meta + rounded pnl
 *  executePortfolioHalt — edge case (1): empty algoIds → no operations
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getTodayAnchor } from "@/lib/utils/date";
import type { Portfolio } from "@/types/portfolio";
import { flattenAlgorithmPositions } from "./flatten";
import { logActivity } from "./helpers";
import {
  checkPortfolioHalt,
  executePortfolioHalt,
  portfolioHaltFiredToday,
  type PortfolioHaltResult,
} from "./portfolio-halt";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/utils/date", () => ({
  getTodayAnchor: vi.fn(),
}));
vi.mock("./flatten", () => ({
  flattenAlgorithmPositions: vi.fn(),
}));
vi.mock("./helpers", () => ({
  logActivity: vi.fn(),
}));

const mockedGetTodayAnchor = vi.mocked(getTodayAnchor);
const mockedFlatten = vi.mocked(flattenAlgorithmPositions);
const mockedLogActivity = vi.mocked(logActivity);

// ---- Supabase mock dispatching by select column. ---------------------
// checkPortfolioHalt fires TWO parallel queries:
//   1. .select("realized_pnl").in().eq("status", "closed").gte("closed_at", ...)
//   2. .select("unrealized_pnl").in().eq("status", "open")
// Both on paper_positions. Dispatch returns the right builder based on
// which select column was requested.
// executePortfolioHalt fires:
//   3. .from("algorithms").update({...}).eq("id", algoId) per algo.
type PnlRow = { realized_pnl?: number | null; unrealized_pnl?: number | null };

function makeSupabaseHaltMock(opts: {
  closedToday?: Array<{ realized_pnl: number | null }>;
  openNow?: Array<{ unrealized_pnl: number | null }>;
} = {}): {
  supabase: SupabaseClient;
  fromMock: ReturnType<typeof vi.fn>;
  capturedSelects: string[];
  capturedClosedFilters: { in?: [string, unknown]; eq?: [string, unknown]; gte?: [string, unknown] };
  capturedOpenFilters: { in?: [string, unknown]; eq?: [string, unknown] };
  capturedAlgoUpdates: Array<{ payload: unknown; eq: [string, unknown] }>;
} {
  const capturedSelects: string[] = [];
  const capturedClosedFilters: typeof returned.capturedClosedFilters = {};
  const capturedOpenFilters: typeof returned.capturedOpenFilters = {};
  const capturedAlgoUpdates: typeof returned.capturedAlgoUpdates = [];

  // Builder factory for the paper_positions queries — terminal-thenable
  // pattern. Dispatches captured-filter map by the select column.
  function makePositionsBuilder(rows: PnlRow[]) {
    const result = { data: rows, error: null };
    const builder = Object.create(null) as Record<string, unknown>;
    builder.in = vi.fn().mockImplementation((col: string, val: unknown) => {
      // Decide which filter-map to write to by inspecting capturedSelects:
      // most-recent select is this query's select.
      const lastSelect = capturedSelects[capturedSelects.length - 1];
      if (lastSelect === "realized_pnl") capturedClosedFilters.in = [col, val];
      else if (lastSelect === "unrealized_pnl") capturedOpenFilters.in = [col, val];
      return builder;
    });
    builder.eq = vi.fn().mockImplementation((col: string, val: unknown) => {
      const lastSelect = capturedSelects[capturedSelects.length - 1];
      if (lastSelect === "realized_pnl") capturedClosedFilters.eq = [col, val];
      else if (lastSelect === "unrealized_pnl") capturedOpenFilters.eq = [col, val];
      return builder;
    });
    builder.gte = vi.fn().mockImplementation((col: string, val: unknown) => {
      capturedClosedFilters.gte = [col, val];
      return builder;
    });
    builder.then = (
      onful?: (v: typeof result) => unknown,
      onrej?: (e: unknown) => unknown
    ) => Promise.resolve(result).then(onful, onrej);
    return builder;
  }

  // Builder factory for the algorithms update — chain is .update().eq()
  function makeAlgoUpdateBuilder() {
    const eqMock = vi.fn().mockImplementation((col: string, val: unknown) => {
      // Pair the eq with the most-recent update payload
      const lastUpdate = capturedAlgoUpdates[capturedAlgoUpdates.length - 1];
      if (lastUpdate) lastUpdate.eq = [col, val];
      return Promise.resolve({ data: null, error: null });
    });
    return {
      update: vi.fn().mockImplementation((payload: unknown) => {
        capturedAlgoUpdates.push({ payload, eq: ["", null] }); // eq populated below
        return { eq: eqMock };
      }),
    };
  }

  const fromMock = vi.fn().mockImplementation((table: string) => {
    if (table === "paper_positions") {
      return {
        select: vi.fn().mockImplementation((cols: string) => {
          capturedSelects.push(cols);
          if (cols === "realized_pnl") {
            return makePositionsBuilder(opts.closedToday ?? []);
          }
          if (cols === "unrealized_pnl") {
            return makePositionsBuilder(opts.openNow ?? []);
          }
          throw new Error(`Unexpected select on paper_positions: ${cols}`);
        }),
      };
    }
    if (table === "algorithms") {
      return makeAlgoUpdateBuilder();
    }
    throw new Error(`Unexpected table: ${table}`);
  });
  const supabaseStub = Object.create(null) as Record<string, unknown>;
  supabaseStub.from = fromMock;

  const returned = {
    supabase: supabaseStub as unknown as SupabaseClient,
    fromMock,
    capturedSelects,
    capturedClosedFilters,
    capturedOpenFilters,
    capturedAlgoUpdates,
  };
  return returned;
}

// ---- Fixture helpers. -------------------------------------------------
function makePortfolio(opts: {
  capital?: number;
  dailyLossLimit?: number;
  dailyLossHaltPct?: number;
} = {}): Portfolio {
  const stub = Object.create(null) as Record<string, unknown>;
  Object.assign(stub, {
    id: "portfolio-1",
    name: "FTMO 100K",
    capital: opts.capital ?? 100_000,
    prop_firm_rules:
      opts.dailyLossLimit === undefined
        ? undefined
        : {
            daily_loss_limit: opts.dailyLossLimit,
            daily_loss_halt_pct: opts.dailyLossHaltPct,
          },
  });
  return stub as unknown as Portfolio;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedGetTodayAnchor.mockReturnValue({
    utcIso: "2026-06-22T00:00:00.000Z",
    utcDate: "2026-06-22",
  });
  mockedFlatten.mockResolvedValue([]);
  mockedLogActivity.mockResolvedValue(undefined);
});

// ======================================================================
// checkPortfolioHalt — null-return paths
// ======================================================================

describe("checkPortfolioHalt — null-return paths", () => {
  it("returns null when prop_firm_rules.daily_loss_limit is undefined (rule disabled)", async () => {
    const { supabase, fromMock } = makeSupabaseHaltMock();
    const result = await checkPortfolioHalt(supabase, makePortfolio({}), ["algo-1"]);
    expect(result).toBeNull();
    // No queries fired
    expect(fromMock).not.toHaveBeenCalled();
  });

  it("returns null when prop_firm_rules itself is undefined", async () => {
    const portfolio = makePortfolio({});
    // Force-set prop_firm_rules to undefined explicitly
    (portfolio as { prop_firm_rules?: unknown }).prop_firm_rules = undefined;
    const { supabase, fromMock } = makeSupabaseHaltMock();
    expect(await checkPortfolioHalt(supabase, portfolio, ["algo-1"])).toBeNull();
    expect(fromMock).not.toHaveBeenCalled();
  });

  it("returns null when algoIds is empty", async () => {
    const { supabase, fromMock } = makeSupabaseHaltMock();
    expect(
      await checkPortfolioHalt(supabase, makePortfolio({ dailyLossLimit: 5 }), [])
    ).toBeNull();
    expect(fromMock).not.toHaveBeenCalled();
  });
});

// ======================================================================
// checkPortfolioHalt — sum computation
// ======================================================================

describe("checkPortfolioHalt — sum computation", () => {
  it("realized = sum of realized_pnl over today's closed trades", async () => {
    const { supabase } = makeSupabaseHaltMock({
      closedToday: [
        { realized_pnl: -1500 },
        { realized_pnl: -800 },
        { realized_pnl: 200 },
      ],
      openNow: [],
    });
    const r = await checkPortfolioHalt(
      supabase,
      makePortfolio({ dailyLossLimit: 5 }),
      ["algo-1", "algo-2"]
    );
    expect(r?.realized).toBe(-2100);
  });

  it("unrealized = sum of unrealized_pnl over open positions", async () => {
    const { supabase } = makeSupabaseHaltMock({
      closedToday: [],
      openNow: [{ unrealized_pnl: -300 }, { unrealized_pnl: -100 }],
    });
    const r = await checkPortfolioHalt(
      supabase,
      makePortfolio({ dailyLossLimit: 5 }),
      ["algo-1"]
    );
    expect(r?.unrealized).toBe(-400);
  });

  it("null pnl coerced to 0 via ?? in both sums", async () => {
    const { supabase } = makeSupabaseHaltMock({
      closedToday: [{ realized_pnl: null }, { realized_pnl: -100 }],
      openNow: [{ unrealized_pnl: null }, { unrealized_pnl: -50 }],
    });
    const r = await checkPortfolioHalt(
      supabase,
      makePortfolio({ dailyLossLimit: 5 }),
      ["algo-1"]
    );
    expect(r?.realized).toBe(-100);
    expect(r?.unrealized).toBe(-50);
  });
});

// ======================================================================
// checkPortfolioHalt — verdict math
// ======================================================================

describe("checkPortfolioHalt — verdict math", () => {
  it("todays_pnl_pct = (realized + unrealized) / capital × 100", async () => {
    const { supabase } = makeSupabaseHaltMock({
      closedToday: [{ realized_pnl: -2500 }],
      openNow: [{ unrealized_pnl: -500 }],
    });
    const r = await checkPortfolioHalt(
      supabase,
      makePortfolio({ capital: 100_000, dailyLossLimit: 5 }),
      ["algo-1"]
    );
    // (-2500 + -500) / 100_000 × 100 = -3.0%
    expect(r?.todays_pnl_pct).toBe(-3.0);
  });

  it("threshold_pct = -daily_loss_limit × (daily_loss_halt_pct ?? 100)/100", async () => {
    const { supabase } = makeSupabaseHaltMock();
    // 5% limit × 80% halt-trigger = -4% threshold
    const r1 = await checkPortfolioHalt(
      supabase,
      makePortfolio({ dailyLossLimit: 5, dailyLossHaltPct: 80 }),
      ["algo-1"]
    );
    expect(r1?.threshold_pct).toBe(-4);

    // Default halt-trigger = 100 → threshold = -5%
    const conf2 = makeSupabaseHaltMock();
    const r2 = await checkPortfolioHalt(
      conf2.supabase,
      makePortfolio({ dailyLossLimit: 5 }),
      ["algo-1"]
    );
    expect(r2?.threshold_pct).toBe(-5);
  });

  it("tripped:true when todays_pnl_pct ≤ threshold (boundary inclusive)", async () => {
    const { supabase } = makeSupabaseHaltMock({
      closedToday: [{ realized_pnl: -5000 }], // -5% of $100K
      openNow: [],
    });
    // At exactly -5% threshold, with default halt-trigger 100, threshold = -5%
    const r = await checkPortfolioHalt(
      supabase,
      makePortfolio({ capital: 100_000, dailyLossLimit: 5 }),
      ["algo-1"]
    );
    expect(r?.tripped).toBe(true); // <= comparison: at threshold trips
    expect(r?.todays_pnl_pct).toBe(-5);
    expect(r?.threshold_pct).toBe(-5);
  });

  it("just above threshold (-4.99%) → tripped:false", async () => {
    const { supabase } = makeSupabaseHaltMock({
      closedToday: [{ realized_pnl: -4990 }],
      openNow: [],
    });
    const r = await checkPortfolioHalt(
      supabase,
      makePortfolio({ capital: 100_000, dailyLossLimit: 5 }),
      ["algo-1"]
    );
    expect(r?.tripped).toBe(false);
    expect(r?.todays_pnl_pct).toBeCloseTo(-4.99, 2);
  });

  it("capital=0 → todays_pnl_pct=0 (avoids div-by-zero)", async () => {
    const { supabase } = makeSupabaseHaltMock({
      closedToday: [{ realized_pnl: -1000 }],
      openNow: [],
    });
    const r = await checkPortfolioHalt(
      supabase,
      makePortfolio({ capital: 0, dailyLossLimit: 5 }),
      ["algo-1"]
    );
    expect(r?.todays_pnl_pct).toBe(0);
    expect(r?.tripped).toBe(false); // 0 > -5
  });

  it("algos_in_portfolio = algoIds.length (passes through)", async () => {
    const { supabase } = makeSupabaseHaltMock();
    const r = await checkPortfolioHalt(
      supabase,
      makePortfolio({ dailyLossLimit: 5 }),
      ["algo-1", "algo-2", "algo-3"]
    );
    expect(r?.algos_in_portfolio).toBe(3);
  });
});

// ======================================================================
// checkPortfolioHalt — query construction
// ======================================================================

describe("checkPortfolioHalt — query construction", () => {
  it("closed query: .in(algorithm_id, algoIds).eq(status, closed).gte(closed_at, startIso)", async () => {
    const conf = makeSupabaseHaltMock();
    await checkPortfolioHalt(
      conf.supabase,
      makePortfolio({ dailyLossLimit: 5 }),
      ["algo-1", "algo-2"]
    );
    expect(conf.capturedClosedFilters.in).toEqual(["algorithm_id", ["algo-1", "algo-2"]]);
    expect(conf.capturedClosedFilters.eq).toEqual(["status", "closed"]);
    expect(conf.capturedClosedFilters.gte).toEqual([
      "closed_at",
      "2026-06-22T00:00:00.000Z",
    ]);
  });

  it("open query: .in(algorithm_id, algoIds).eq(status, open) — no gte filter", async () => {
    const conf = makeSupabaseHaltMock();
    await checkPortfolioHalt(
      conf.supabase,
      makePortfolio({ dailyLossLimit: 5 }),
      ["algo-1"]
    );
    expect(conf.capturedOpenFilters.in).toEqual(["algorithm_id", ["algo-1"]]);
    expect(conf.capturedOpenFilters.eq).toEqual(["status", "open"]);
  });

  it("uses getTodayAnchor().utcIso for the closed_at >= filter", async () => {
    const conf = makeSupabaseHaltMock();
    mockedGetTodayAnchor.mockReturnValue({
      utcIso: "2026-12-31T00:00:00.000Z",
      utcDate: "2026-12-31",
    });
    await checkPortfolioHalt(
      conf.supabase,
      makePortfolio({ dailyLossLimit: 5 }),
      ["algo-1"]
    );
    expect(conf.capturedClosedFilters.gte?.[1]).toBe("2026-12-31T00:00:00.000Z");
  });
});

// ======================================================================
// executePortfolioHalt — side effects
// ======================================================================

describe("executePortfolioHalt — side effects per algo", () => {
  const SAMPLE_RESULT: PortfolioHaltResult = {
    tripped: true,
    todays_pnl_pct: -5.234567,
    threshold_pct: -5.0,
    realized: -3000.456,
    unrealized: -2234.111,
    algos_in_portfolio: 2,
  };

  it("calls flattenAlgorithmPositions(supabase, algoId, 'portfolio_halt') per algo", async () => {
    const { supabase } = makeSupabaseHaltMock();
    await executePortfolioHalt(
      supabase,
      "user-1",
      makePortfolio({ dailyLossLimit: 5 }),
      ["algo-1", "algo-2"],
      SAMPLE_RESULT
    );
    expect(mockedFlatten).toHaveBeenCalledTimes(2);
    expect(mockedFlatten).toHaveBeenNthCalledWith(1, supabase, "algo-1", "portfolio_halt");
    expect(mockedFlatten).toHaveBeenNthCalledWith(2, supabase, "algo-2", "portfolio_halt");
  });

  it("updates algorithms.live_trading_enabled = false per algo (matched by id)", async () => {
    const conf = makeSupabaseHaltMock();
    await executePortfolioHalt(
      conf.supabase,
      "user-1",
      makePortfolio({ dailyLossLimit: 5 }),
      ["algo-1", "algo-2"],
      SAMPLE_RESULT
    );
    expect(conf.capturedAlgoUpdates).toHaveLength(2);
    expect(conf.capturedAlgoUpdates[0].payload).toEqual({ live_trading_enabled: false });
    expect(conf.capturedAlgoUpdates[0].eq).toEqual(["id", "algo-1"]);
    expect(conf.capturedAlgoUpdates[1].payload).toEqual({ live_trading_enabled: false });
    expect(conf.capturedAlgoUpdates[1].eq).toEqual(["id", "algo-2"]);
  });

  it("logActivity per algo with portfolio_halt event + rounded payload (3dp pct, 2dp $)", async () => {
    mockedFlatten.mockResolvedValue([
      { id: "pos-1", ticker: "XAU/USD" },
      { id: "pos-2", ticker: "EUR/USD" },
    ] as Array<{ id: string; ticker: string }>);
    const { supabase } = makeSupabaseHaltMock();
    await executePortfolioHalt(
      supabase,
      "user-1",
      makePortfolio({ dailyLossLimit: 5 }),
      ["algo-1"],
      SAMPLE_RESULT
    );
    expect(mockedLogActivity).toHaveBeenCalledOnce();
    const logCall = mockedLogActivity.mock.calls[0];
    expect(logCall[2]).toMatchObject({
      algorithm_id: "algo-1",
      event_type: "portfolio_halt",
      details: {
        portfolio_id: "portfolio-1",
        portfolio_name: "FTMO 100K",
        todays_pnl_pct: -5.235, // 3 decimal places via toFixed(3)
        threshold_pct: -5,
        realized: -3000.46, // 2 decimal places via toFixed(2)
        unrealized: -2234.11,
        positions_flattened: 2,
        // CRITICAL: algos_in_portfolio in the log payload comes from
        // algoIds.length (the caller's loop arg), NOT from
        // result.algos_in_portfolio. The test passes ["algo-1"] so
        // length=1 even though SAMPLE_RESULT.algos_in_portfolio=2.
        algos_in_portfolio: 1,
      },
    });
  });

  it("empty algoIds → no flatten / no update / no log (loop never enters)", async () => {
    const conf = makeSupabaseHaltMock();
    await executePortfolioHalt(
      conf.supabase,
      "user-1",
      makePortfolio({ dailyLossLimit: 5 }),
      [],
      SAMPLE_RESULT
    );
    expect(mockedFlatten).not.toHaveBeenCalled();
    expect(conf.capturedAlgoUpdates).toHaveLength(0);
    expect(mockedLogActivity).not.toHaveBeenCalled();
  });
});

// ======================================================================
// portfolioHaltFiredToday — E2.25.d idempotency guard
// ======================================================================

/** Minimal activity_log query stub: .select().eq().gte().filter().limit().maybeSingle() */
function makeActivityLogMock(existingRow: { id: string } | null): {
  supabase: SupabaseClient;
  captured: { eq: Array<[string, unknown]>; gte?: [string, unknown]; filter?: [string, string, unknown] };
} {
  const captured: { eq: Array<[string, unknown]>; gte?: [string, unknown]; filter?: [string, string, unknown] } = {
    eq: [],
  };
  const builder: Record<string, unknown> = {};
  builder.select = vi.fn().mockReturnValue(builder);
  builder.eq = vi.fn().mockImplementation((c: string, v: unknown) => {
    captured.eq.push([c, v]);
    return builder;
  });
  builder.gte = vi.fn().mockImplementation((c: string, v: unknown) => {
    captured.gte = [c, v];
    return builder;
  });
  builder.filter = vi.fn().mockImplementation((c: string, op: string, v: unknown) => {
    captured.filter = [c, op, v];
    return builder;
  });
  builder.limit = vi.fn().mockReturnValue(builder);
  builder.maybeSingle = vi.fn().mockResolvedValue({ data: existingRow, error: null });
  const stub = Object.create(null) as Record<string, unknown>;
  stub.from = vi.fn().mockImplementation((table: string) => {
    if (table !== "activity_log") throw new Error(`unexpected table ${table}`);
    return builder;
  });
  return { supabase: stub as unknown as SupabaseClient, captured };
}

describe("portfolioHaltFiredToday", () => {
  it("returns true when a portfolio_halt row exists today for the portfolio", async () => {
    const { supabase, captured } = makeActivityLogMock({ id: "log-1" });
    const fired = await portfolioHaltFiredToday(supabase, "portfolio-1");
    expect(fired).toBe(true);
    // Scoped to the right event type, portfolio, and today's anchor.
    expect(captured.eq).toContainEqual(["event_type", "portfolio_halt"]);
    expect(captured.filter).toEqual(["details->>portfolio_id", "eq", "portfolio-1"]);
    expect(captured.gte).toEqual(["created_at", "2026-06-22T00:00:00.000Z"]);
  });

  it("returns false when no halt row exists today", async () => {
    const { supabase } = makeActivityLogMock(null);
    expect(await portfolioHaltFiredToday(supabase, "portfolio-1")).toBe(false);
  });
});
