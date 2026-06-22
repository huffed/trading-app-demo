/**
 * Unit tests for the per-algo daily-loss-limit halt (CB.T1.5, 2026-06-22 EVE).
 * Highest survival-risk untested module: silent regression here = challenge
 * fail on a real algo passing the daily loss limit.
 *
 * Module exposes 4 public functions:
 *
 *  1. checkDailyLossHalt — pure DB-query, sums realized+unrealized, computes vs threshold
 *  2. executeDailyHalt — side-effects: flatten + disable live_trading + logActivity
 *  3. maybeHaltOnDailyLoss — orchestrator: reads prop_firm rule, conditional check+execute
 *  4. maybeWarnOnDailyLoss — 40% soft warning with per-UTC-day idempotency
 *
 * Coverage (~28 tests):
 *
 *  checkDailyLossHalt (10):
 *   - Empty closed+open → 0 realized / 0 unrealized / 0% / not-tripped
 *   - haltPct=100 (default) → threshold = -dll
 *   - haltPct=80 → threshold = -dll × 0.8
 *   - haltPct=40 → threshold = -dll × 0.4 (warning case)
 *   - capital=0 → todaysPnlPct=0 (div-by-zero guard)
 *   - null realized_pnl / null unrealized_pnl coerced to 0
 *   - realized + unrealized combined drawdown crosses threshold → tripped:true
 *   - boundary: todaysPnlPct exactly at threshold → tripped:true (<= comparison)
 *   - boundary: todaysPnlPct just above threshold → tripped:false
 *   - Query construction: paper_positions × 2 with correct .eq filters + .gte UTC midnight
 *
 *  executeDailyHalt (4):
 *   - Calls flattenAlgorithmPositions(supabase, algoId, "daily_loss_halt")
 *   - Updates algorithms.live_trading_enabled=false matched by id
 *   - logActivity emits daily_loss_halt with rounded payload (3dp pct / 2dp $)
 *   - positions_flattened reflects flatten's return-array length
 *
 *  maybeHaltOnDailyLoss (5):
 *   - No prop_firm rule → returns false, NO DB call
 *   - prop_firm but daily_loss_limit undefined → returns false, NO DB call
 *   - Not tripped → executeDailyHalt NOT called, returns false
 *   - Tripped → executeDailyHalt called, returns true
 *   - daily_loss_halt_pct override threads through (e.g. 80 → uses 80, not 100)
 *
 *  maybeWarnOnDailyLoss (9):
 *   - No prop_firm rule → false
 *   - prop_firm but daily_loss_limit undefined → false
 *   - Below warn threshold (40%) → false, NO activity_log query
 *   - At warn threshold + no existing warning today → logActivity called, returns true
 *   - At warn threshold + existing warning today → returns false (idempotency)
 *   - Idempotency query: activity_log + algorithm_id + event_type=dll_warning + gte today
 *   - Payload includes halt_threshold_pct using FULL daily_loss_halt_pct (not 40 override)
 *   - Payload message includes algo id prefix (first 8 chars) + intraday pct
 *   - Default daily_loss_halt_pct (undefined → 100) threads into halt_threshold_pct
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AlgorithmRules } from "@/types/algorithm";
import {
  checkDailyLossHalt,
  executeDailyHalt,
  maybeHaltOnDailyLoss,
  maybeWarnOnDailyLoss,
} from "./daily-halt";
import { flattenAlgorithmPositions } from "./flatten";
import { logActivity } from "./helpers";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("./flatten", () => ({ flattenAlgorithmPositions: vi.fn() }));
vi.mock("./helpers", () => ({ logActivity: vi.fn() }));

const mockedFlatten = vi.mocked(flattenAlgorithmPositions);
const mockedLogActivity = vi.mocked(logActivity);

// ---- Supabase mock that dispatches by table. -------------------------
// paper_positions: called TWICE per checkDailyLossHalt — first for
//   closed-today, second for open-now. Mock uses a queue so callers can
//   supply different data for each.
// algorithms: .update({...}).eq("id", X) — captures call + resolves.
// activity_log: .select("id").eq.eq.gte.limit(1) — terminal limit.
type ClosedShape = { realized_pnl: number | null };
type OpenShape = { unrealized_pnl: number | null };
type ActLogShape = { id: string };

interface SupabaseMockBag {
  supabase: SupabaseClient;
  fromMock: ReturnType<typeof vi.fn>;
  // capture for paper_positions queries (one entry per call)
  capturedPaperQueries: Array<{
    select: string | null;
    eq: Array<[string, unknown]>;
    gte: [string, unknown] | null;
  }>;
  capturedAlgoUpdate: { payload: unknown; eq: [string, unknown] | null } | null;
  capturedActivityLogQuery: {
    select: string | null;
    eq: Array<[string, unknown]>;
    gte: [string, unknown] | null;
    limit: number | null;
  } | null;
}

function makeSupabaseDailyHaltMock(opts: {
  closedData?: ClosedShape[];
  openData?: OpenShape[];
  existingWarnings?: ActLogShape[]; // for activity_log idempotency
} = {}): SupabaseMockBag {
  const closedQueue: ClosedShape[][] = [opts.closedData ?? []];
  const openQueue: OpenShape[][] = [opts.openData ?? []];
  const activityLogQueue: ActLogShape[][] = [opts.existingWarnings ?? []];

  const capturedPaperQueries: SupabaseMockBag["capturedPaperQueries"] = [];
  let capturedAlgoUpdate: SupabaseMockBag["capturedAlgoUpdate"] = null;
  let capturedActivityLogQuery: SupabaseMockBag["capturedActivityLogQuery"] = null;
  let paperCallCounter = 0;

  // Builder factory for paper_positions (closed=1st call, open=2nd call).
  function makePaperBuilder() {
    const captured = {
      select: null as string | null,
      eq: [] as Array<[string, unknown]>,
      gte: null as [string, unknown] | null,
    };
    capturedPaperQueries.push(captured);
    const callIndex = paperCallCounter++;

    const builder: Record<string, unknown> = {};
    builder.eq = vi.fn().mockImplementation((col: string, val: unknown) => {
      captured.eq.push([col, val]);
      return builder;
    });
    builder.gte = vi.fn().mockImplementation((col: string, val: unknown) => {
      captured.gte = [col, val];
      return builder;
    });
    // Resolve as thenable — pick from closed or open queue based on callIndex.
    builder.then = (onful?: (v: unknown) => unknown, onrej?: (e: unknown) => unknown) => {
      const data = callIndex === 0 ? closedQueue[0] : openQueue[0];
      return Promise.resolve({ data, error: null }).then(onful, onrej);
    };
    return {
      select: vi.fn().mockImplementation((cols: string) => {
        captured.select = cols;
        return builder;
      }),
    };
  }

  // Builder for algorithms.update().eq() — captures + resolves.
  function makeAlgoBuilder() {
    const obj: Record<string, unknown> = {
      update: vi.fn().mockImplementation((payload: unknown) => {
        capturedAlgoUpdate = { payload, eq: null };
        return {
          eq: vi.fn().mockImplementation((col: string, val: unknown) => {
            if (capturedAlgoUpdate) capturedAlgoUpdate.eq = [col, val];
            return Promise.resolve({ data: null, error: null });
          }),
        };
      }),
    };
    return obj;
  }

  // Builder for activity_log idempotency query.
  function makeActivityLogBuilder() {
    const captured: NonNullable<SupabaseMockBag["capturedActivityLogQuery"]> = {
      select: null,
      eq: [],
      gte: null,
      limit: null,
    };
    capturedActivityLogQuery = captured;

    const builder: Record<string, unknown> = {};
    builder.eq = vi.fn().mockImplementation((col: string, val: unknown) => {
      captured.eq.push([col, val]);
      return builder;
    });
    builder.gte = vi.fn().mockImplementation((col: string, val: unknown) => {
      captured.gte = [col, val];
      return builder;
    });
    builder.limit = vi.fn().mockImplementation((n: number) => {
      captured.limit = n;
      return Promise.resolve({ data: activityLogQueue[0], error: null });
    });
    return {
      select: vi.fn().mockImplementation((cols: string) => {
        captured.select = cols;
        return builder;
      }),
    };
  }

  const fromMock = vi.fn().mockImplementation((table: string) => {
    if (table === "paper_positions") return makePaperBuilder();
    if (table === "algorithms") return makeAlgoBuilder();
    if (table === "activity_log") return makeActivityLogBuilder();
    throw new Error(`Unexpected table: ${table}`);
  });

  const supabaseStub = Object.create(null) as Record<string, unknown>;
  supabaseStub.from = fromMock;
  return {
    supabase: supabaseStub as unknown as SupabaseClient,
    fromMock,
    capturedPaperQueries,
    get capturedAlgoUpdate() {
      return capturedAlgoUpdate;
    },
    get capturedActivityLogQuery() {
      return capturedActivityLogQuery;
    },
  };
}

// ---- Fixture helpers. -------------------------------------------------
function makeRules(overrides: { daily_loss_limit?: number; daily_loss_halt_pct?: number } = {}): AlgorithmRules {
  return {
    timeframe: "4h",
    asset_class: "commodities",
    side: "long",
    position_sizing: { type: "risk_per_trade", value: 1 },
    stop_loss: { type: "percentage", value: 1.5 },
    take_profit: { type: "percentage", value: 3 },
    entry_conditions: [],
    exit_conditions: [],
    prop_firm:
      overrides.daily_loss_limit !== undefined || overrides.daily_loss_halt_pct !== undefined
        ? { ...overrides }
        : undefined,
  } as unknown as AlgorithmRules;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedFlatten.mockResolvedValue([]);
  mockedLogActivity.mockResolvedValue(undefined);
});

// ======================================================================
// checkDailyLossHalt — pure-query pnl math
// ======================================================================

describe("checkDailyLossHalt — sum + threshold math", () => {
  it("empty closed + open → all zero, not tripped", async () => {
    const { supabase } = makeSupabaseDailyHaltMock();
    const r = await checkDailyLossHalt(supabase, "algo-1", 10_000, 5);
    expect(r).toEqual({
      tripped: false,
      todaysPnlPct: 0,
      thresholdPct: -5, // -dll × (100/100) = -5
      realized: 0,
      unrealized: 0,
    });
  });

  it("haltPct=100 (default) → threshold = -dll", async () => {
    const { supabase } = makeSupabaseDailyHaltMock();
    const r = await checkDailyLossHalt(supabase, "algo-1", 10_000, 5);
    expect(r.thresholdPct).toBe(-5);
  });

  it("haltPct=80 → threshold = -dll × 0.8 (defensive 80%-of-DLL halt)", async () => {
    const { supabase } = makeSupabaseDailyHaltMock();
    const r = await checkDailyLossHalt(supabase, "algo-1", 10_000, 5, 80);
    expect(r.thresholdPct).toBe(-4);
  });

  it("haltPct=40 → threshold = -dll × 0.4 (warning case)", async () => {
    const { supabase } = makeSupabaseDailyHaltMock();
    const r = await checkDailyLossHalt(supabase, "algo-1", 10_000, 5, 40);
    expect(r.thresholdPct).toBe(-2);
  });

  it("capital=0 → todaysPnlPct=0 (div-by-zero guard, regardless of pnl)", async () => {
    const { supabase } = makeSupabaseDailyHaltMock({
      closedData: [{ realized_pnl: -500 }],
      openData: [{ unrealized_pnl: -200 }],
    });
    const r = await checkDailyLossHalt(supabase, "algo-1", 0, 5);
    expect(r.todaysPnlPct).toBe(0);
    expect(r.tripped).toBe(false);
  });

  it("null realized_pnl / null unrealized_pnl coerced to 0 in sums", async () => {
    const { supabase } = makeSupabaseDailyHaltMock({
      closedData: [{ realized_pnl: null }, { realized_pnl: -50 }],
      openData: [{ unrealized_pnl: null }, { unrealized_pnl: -25 }],
    });
    const r = await checkDailyLossHalt(supabase, "algo-1", 10_000, 5);
    expect(r.realized).toBe(-50); // null + (-50) → -50
    expect(r.unrealized).toBe(-25);
  });

  it("realized + unrealized combined drawdown crosses threshold → tripped:true", async () => {
    const { supabase } = makeSupabaseDailyHaltMock({
      closedData: [{ realized_pnl: -300 }], // -3%
      openData: [{ unrealized_pnl: -250 }], // -2.5%
    });
    // combined -550 = -5.5% on 10k; threshold = -5%
    const r = await checkDailyLossHalt(supabase, "algo-1", 10_000, 5);
    expect(r.todaysPnlPct).toBe(-5.5);
    expect(r.tripped).toBe(true);
  });

  it("boundary: todaysPnlPct exactly at threshold → tripped:true (<= comparison)", async () => {
    const { supabase } = makeSupabaseDailyHaltMock({
      closedData: [{ realized_pnl: -500 }], // -5%
    });
    const r = await checkDailyLossHalt(supabase, "algo-1", 10_000, 5);
    expect(r.todaysPnlPct).toBe(-5);
    expect(r.thresholdPct).toBe(-5);
    expect(r.tripped).toBe(true); // exactly at threshold trips
  });

  it("boundary: todaysPnlPct just above threshold → tripped:false", async () => {
    const { supabase } = makeSupabaseDailyHaltMock({
      closedData: [{ realized_pnl: -499 }], // -4.99%
    });
    const r = await checkDailyLossHalt(supabase, "algo-1", 10_000, 5);
    expect(r.todaysPnlPct).toBeCloseTo(-4.99, 2);
    expect(r.tripped).toBe(false);
  });

  it("query construction: 2× paper_positions with correct filters + UTC-midnight .gte on closed", async () => {
    const conf = makeSupabaseDailyHaltMock();
    await checkDailyLossHalt(conf.supabase, "algo-XYZ", 10_000, 5);
    // 2 paper_positions queries captured
    expect(conf.capturedPaperQueries).toHaveLength(2);
    // First (closed): select realized_pnl + eq(algo+status=closed) + gte(closed_at, UTC midnight)
    const closedQ = conf.capturedPaperQueries[0];
    expect(closedQ.select).toBe("realized_pnl");
    expect(closedQ.eq).toEqual([
      ["algorithm_id", "algo-XYZ"],
      ["status", "closed"],
    ]);
    expect(closedQ.gte?.[0]).toBe("closed_at");
    expect(closedQ.gte?.[1]).toMatch(/T00:00:00\.000Z$/); // UTC midnight
    const todayPrefix = new Date().toISOString().slice(0, 10);
    expect((closedQ.gte?.[1] as string).startsWith(todayPrefix)).toBe(true);
    // Second (open): select unrealized_pnl + eq(algo+status=open) + NO gte
    const openQ = conf.capturedPaperQueries[1];
    expect(openQ.select).toBe("unrealized_pnl");
    expect(openQ.eq).toEqual([
      ["algorithm_id", "algo-XYZ"],
      ["status", "open"],
    ]);
    expect(openQ.gte).toBeNull();
  });
});

// ======================================================================
// executeDailyHalt — side effects
// ======================================================================

describe("executeDailyHalt — side effects", () => {
  const check = {
    tripped: true,
    todaysPnlPct: -5.123,
    thresholdPct: -5,
    realized: -300.5,
    unrealized: -212.345,
  };

  it("calls flattenAlgorithmPositions(supabase, algoId, 'daily_loss_halt')", async () => {
    const { supabase } = makeSupabaseDailyHaltMock();
    await executeDailyHalt(supabase, "user-1", "algo-1", check);
    expect(mockedFlatten).toHaveBeenCalledWith(supabase, "algo-1", "daily_loss_halt");
  });

  it("updates algorithms.live_trading_enabled=false matched by id", async () => {
    const conf = makeSupabaseDailyHaltMock();
    await executeDailyHalt(conf.supabase, "user-1", "algo-1", check);
    expect(conf.capturedAlgoUpdate?.payload).toEqual({ live_trading_enabled: false });
    expect(conf.capturedAlgoUpdate?.eq).toEqual(["id", "algo-1"]);
  });

  it("logActivity emits daily_loss_halt with rounded payload (3dp pct / 2dp $)", async () => {
    const { supabase } = makeSupabaseDailyHaltMock();
    await executeDailyHalt(supabase, "user-1", "algo-1", check);
    expect(mockedLogActivity).toHaveBeenCalledTimes(1);
    const call = mockedLogActivity.mock.calls[0];
    expect(call[1]).toBe("user-1");
    expect(call[2]).toMatchObject({
      algorithm_id: "algo-1",
      event_type: "daily_loss_halt",
      details: {
        todays_pnl_pct: -5.123, // 3dp
        threshold_pct: -5, // 3dp (trailing zeros stripped by Number())
        realized: -300.5, // 2dp
        unrealized: -212.34, // 2dp — JS floating-point: (-212.345).toFixed(2) === "-212.34"
        positions_flattened: 0,
      },
    });
  });

  it("positions_flattened reflects flatten's return-array length", async () => {
    mockedFlatten.mockResolvedValue([
      { positionId: "p1", brokerClosed: true, paperClosed: true },
      { positionId: "p2", brokerClosed: true, paperClosed: true },
      { positionId: "p3", brokerClosed: true, paperClosed: true },
    ] as Array<{ positionId: string; brokerClosed: boolean; paperClosed: boolean }>);
    const { supabase } = makeSupabaseDailyHaltMock();
    await executeDailyHalt(supabase, "user-1", "algo-1", check);
    const call = mockedLogActivity.mock.calls[0];
    expect((call[2] as { details: { positions_flattened: number } }).details.positions_flattened).toBe(3);
  });
});

// ======================================================================
// maybeHaltOnDailyLoss — orchestrator
// ======================================================================

describe("maybeHaltOnDailyLoss — orchestrator", () => {
  it("no prop_firm rule → returns false, NO DB call", async () => {
    const conf = makeSupabaseDailyHaltMock();
    const result = await maybeHaltOnDailyLoss(conf.supabase, "user-1", {
      id: "algo-1",
      capital: 10_000,
      rules: makeRules(),
    });
    expect(result).toBe(false);
    expect(conf.fromMock).not.toHaveBeenCalled();
    expect(mockedFlatten).not.toHaveBeenCalled();
  });

  it("prop_firm but daily_loss_limit undefined → returns false, NO DB call", async () => {
    const conf = makeSupabaseDailyHaltMock();
    // empty prop_firm object — daily_loss_limit absent
    const rules = { prop_firm: {} } as unknown as AlgorithmRules;
    const result = await maybeHaltOnDailyLoss(conf.supabase, "user-1", {
      id: "algo-1",
      capital: 10_000,
      rules,
    });
    expect(result).toBe(false);
    expect(conf.fromMock).not.toHaveBeenCalled();
  });

  it("not tripped → executeDailyHalt NOT called, returns false", async () => {
    const conf = makeSupabaseDailyHaltMock({
      closedData: [{ realized_pnl: -100 }], // -1% on 10k, well above -5% threshold
    });
    const result = await maybeHaltOnDailyLoss(conf.supabase, "user-1", {
      id: "algo-1",
      capital: 10_000,
      rules: makeRules({ daily_loss_limit: 5 }),
    });
    expect(result).toBe(false);
    expect(mockedFlatten).not.toHaveBeenCalled();
    expect(mockedLogActivity).not.toHaveBeenCalled();
  });

  it("tripped → executeDailyHalt called (flatten + update + log), returns true", async () => {
    const conf = makeSupabaseDailyHaltMock({
      closedData: [{ realized_pnl: -600 }], // -6% on 10k, below -5%
    });
    const result = await maybeHaltOnDailyLoss(conf.supabase, "user-1", {
      id: "algo-1",
      capital: 10_000,
      rules: makeRules({ daily_loss_limit: 5 }),
    });
    expect(result).toBe(true);
    expect(mockedFlatten).toHaveBeenCalledWith(conf.supabase, "algo-1", "daily_loss_halt");
    expect(conf.capturedAlgoUpdate?.payload).toEqual({ live_trading_enabled: false });
    expect(mockedLogActivity).toHaveBeenCalledTimes(1);
  });

  it("daily_loss_halt_pct=80 threads through (threshold becomes -dll × 0.8)", async () => {
    // -4% on 10k with dll=5, halt_pct=80 → threshold = -4% exactly → tripped
    const conf = makeSupabaseDailyHaltMock({
      closedData: [{ realized_pnl: -400 }],
    });
    const result = await maybeHaltOnDailyLoss(conf.supabase, "user-1", {
      id: "algo-1",
      capital: 10_000,
      rules: makeRules({ daily_loss_limit: 5, daily_loss_halt_pct: 80 }),
    });
    expect(result).toBe(true); // tripped at -4% (= -5 × 0.8)
    // Confirm threshold made it into the executeDailyHalt payload
    const logCall = mockedLogActivity.mock.calls[0];
    expect((logCall[2] as { details: { threshold_pct: number } }).details.threshold_pct).toBe(-4);
  });
});

// ======================================================================
// maybeWarnOnDailyLoss — 40% soft warning with idempotency
// ======================================================================

describe("maybeWarnOnDailyLoss — 40% warning + idempotency", () => {
  it("no prop_firm → false, NO DB call", async () => {
    const conf = makeSupabaseDailyHaltMock();
    const r = await maybeWarnOnDailyLoss(conf.supabase, "user-1", {
      id: "algo-12345678abc",
      capital: 10_000,
      rules: makeRules(),
    });
    expect(r).toBe(false);
    expect(conf.fromMock).not.toHaveBeenCalled();
  });

  it("prop_firm but daily_loss_limit undefined → false, NO DB call", async () => {
    const conf = makeSupabaseDailyHaltMock();
    const rules = { prop_firm: {} } as unknown as AlgorithmRules;
    const r = await maybeWarnOnDailyLoss(conf.supabase, "user-1", {
      id: "algo-1",
      capital: 10_000,
      rules,
    });
    expect(r).toBe(false);
    expect(conf.fromMock).not.toHaveBeenCalled();
  });

  it("below warn threshold (40%) → false, NO activity_log query", async () => {
    // -100 / 10k = -1%; warn threshold = -5 × 0.4 = -2%; -1% > -2% → not at warn
    const conf = makeSupabaseDailyHaltMock({
      closedData: [{ realized_pnl: -100 }],
    });
    const r = await maybeWarnOnDailyLoss(conf.supabase, "user-1", {
      id: "algo-1",
      capital: 10_000,
      rules: makeRules({ daily_loss_limit: 5 }),
    });
    expect(r).toBe(false);
    // activity_log NOT queried (warning not at threshold)
    expect(conf.capturedActivityLogQuery).toBeNull();
    expect(mockedLogActivity).not.toHaveBeenCalled();
  });

  it("at warn threshold + no existing warning today → logs + returns true", async () => {
    // -250 / 10k = -2.5%; warn threshold = -2% → tripped
    const conf = makeSupabaseDailyHaltMock({
      closedData: [{ realized_pnl: -250 }],
      existingWarnings: [], // no prior warning today
    });
    const r = await maybeWarnOnDailyLoss(conf.supabase, "user-1", {
      id: "algo-12345678abc",
      capital: 10_000,
      rules: makeRules({ daily_loss_limit: 5 }),
    });
    expect(r).toBe(true);
    expect(mockedLogActivity).toHaveBeenCalledTimes(1);
    expect(mockedLogActivity.mock.calls[0][2]).toMatchObject({
      algorithm_id: "algo-12345678abc",
      event_type: "dll_warning",
    });
  });

  it("at warn threshold + existing warning today → returns false (idempotency)", async () => {
    const conf = makeSupabaseDailyHaltMock({
      closedData: [{ realized_pnl: -250 }],
      existingWarnings: [{ id: "log-1" }], // already warned today
    });
    const r = await maybeWarnOnDailyLoss(conf.supabase, "user-1", {
      id: "algo-1",
      capital: 10_000,
      rules: makeRules({ daily_loss_limit: 5 }),
    });
    expect(r).toBe(false);
    expect(mockedLogActivity).not.toHaveBeenCalled();
  });

  it("idempotency query: activity_log + algorithm_id + event_type=dll_warning + gte UTC midnight + limit 1", async () => {
    const conf = makeSupabaseDailyHaltMock({
      closedData: [{ realized_pnl: -250 }],
      existingWarnings: [],
    });
    await maybeWarnOnDailyLoss(conf.supabase, "user-1", {
      id: "algo-XYZ",
      capital: 10_000,
      rules: makeRules({ daily_loss_limit: 5 }),
    });
    expect(conf.capturedActivityLogQuery).not.toBeNull();
    const q = conf.capturedActivityLogQuery!;
    expect(q.select).toBe("id");
    expect(q.eq).toEqual([
      ["algorithm_id", "algo-XYZ"],
      ["event_type", "dll_warning"],
    ]);
    expect(q.gte?.[0]).toBe("created_at");
    expect(q.gte?.[1]).toMatch(/T00:00:00\.000Z$/); // UTC midnight
    expect(q.limit).toBe(1);
  });

  it("payload halt_threshold_pct uses FULL daily_loss_halt_pct, NOT the 40% warn override", async () => {
    const conf = makeSupabaseDailyHaltMock({
      closedData: [{ realized_pnl: -250 }],
      existingWarnings: [],
    });
    await maybeWarnOnDailyLoss(conf.supabase, "user-1", {
      id: "algo-1",
      capital: 10_000,
      rules: makeRules({ daily_loss_limit: 5, daily_loss_halt_pct: 80 }),
    });
    // halt_threshold_pct = -5 × (80/100) = -4 (the actual halt threshold)
    // warn_threshold_pct = -5 × (40/100) = -2 (the warn threshold used internally)
    const details = (mockedLogActivity.mock.calls[0][2] as { details: Record<string, number> }).details;
    expect(details.halt_threshold_pct).toBe(-4);
    expect(details.warn_threshold_pct).toBe(-2);
  });

  it("default daily_loss_halt_pct (undefined → 100) → halt_threshold_pct = -dll", async () => {
    const conf = makeSupabaseDailyHaltMock({
      closedData: [{ realized_pnl: -250 }],
      existingWarnings: [],
    });
    await maybeWarnOnDailyLoss(conf.supabase, "user-1", {
      id: "algo-1",
      capital: 10_000,
      rules: makeRules({ daily_loss_limit: 5 }), // no halt_pct override
    });
    const details = (mockedLogActivity.mock.calls[0][2] as { details: Record<string, number> }).details;
    expect(details.halt_threshold_pct).toBe(-5); // -dll × 1.0
  });

  it("payload message includes algo id prefix (first 8 chars) + intraday pct + DLL halt phrase", async () => {
    const conf = makeSupabaseDailyHaltMock({
      closedData: [{ realized_pnl: -250 }],
      existingWarnings: [],
    });
    await maybeWarnOnDailyLoss(conf.supabase, "user-1", {
      id: "algo-deadbeef-extra-junk",
      capital: 10_000,
      rules: makeRules({ daily_loss_limit: 5 }),
    });
    const details = (mockedLogActivity.mock.calls[0][2] as { details: { message: string } }).details;
    expect(details.message).toContain("Algo algo-dea"); // first 8 chars
    expect(details.message).toContain("-2.50%"); // todaysPnlPct (-2.5%, formatted to 2dp)
    expect(details.message).toContain("DLL halt");
  });
});
