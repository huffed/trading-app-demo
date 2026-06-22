/**
 * Unit tests for broker-position-sync (CB.T1 pass 22 + CB.H1 pass 7 hybrid,
 * 2026-06-22). Tests the 2 exports extracted from manage.ts:
 *   - syncBrokerUnrealizedPnl (per-tick broker_unrealized_pnl refresh)
 *   - reconcileMissingBrokerPosition (broker-side close detection +
 *     exit_reason classification via SL/TP tolerance match)
 *
 * Coverage (~22 tests):
 *  syncBrokerUnrealizedPnl:
 *   - brokerCtx null → early return (no fetch, no update)
 *   - Empty positions → early return
 *   - No mirrored positions (all broker_position_id null) → early return
 *   - fetchPositions throws → logger.warn + return (no update, no overwrite)
 *   - Position present on broker → UPDATE broker_unrealized_pnl + synced_at
 *   - broker.profit=null → coerced to 0 (defensive Number() ?? 0)
 *   - Multiple mirrored positions → each updated independently
 *   - Position MISSING from broker → reconcileMissingBrokerPosition called
 *   - Mix of present + missing → present gets UPDATE, missing gets reconcile
 *
 *  reconcileMissingBrokerPosition:
 *   - Adapter without fetchClosedDealForPosition → early return
 *   - paper.broker_position_id null → early return
 *   - fetcher returns null (deal not yet settled) → no update, no log
 *   - fetcher returns deal → paper closed with broker truth
 *   - exit_reason='stop_loss' when close price ≈ SL (within 0.1% tolerance)
 *   - exit_reason='take_profit' when close price ≈ TP
 *   - exit_reason='manual' when close price matches neither
 *   - SL takes precedence over TP if both within tolerance (extreme edge)
 *   - Tolerance is 0.1% of CLOSE price (not target price)
 *   - SL/TP null in paper row → silently skipped in classification
 *   - .eq("status", "open") guard applied (race-safe against concurrent close)
 *   - UPDATE payload carries all 7 broker-truth fields
 *   - logActivity event_type='live_order_closed' with classified exit_reason
 *   - Log details include sl_price + tp_price + closed_at + broker_position_id
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrokerAdapter, BrokerConnection } from "@/lib/brokers/types";
import { logger } from "@/lib/logger";
import type { PaperPosition } from "@/types/position";
import {
  reconcileMissingBrokerPosition,
  syncBrokerUnrealizedPnl,
} from "./broker-position-sync";
import { logActivity } from "./helpers";
import type { SupabaseClient } from "@supabase/supabase-js";

// ---- Mocks. -----------------------------------------------------------
vi.mock("./helpers", () => ({
  logActivity: vi.fn(),
}));
vi.mock("@/lib/logger", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const mockedLogActivity = vi.mocked(logActivity);
const mockedLogger = vi.mocked(logger);

// ---- Fixture builders. ------------------------------------------------
function makePaper(overrides: Partial<PaperPosition> = {}): PaperPosition {
  const stub = Object.create(null) as Record<string, unknown>;
  Object.assign(stub, {
    id: "pp-1",
    user_id: "user-1",
    algorithm_id: "algo-1",
    ticker: "XAU/USD",
    side: "long",
    quantity: 1,
    entry_price: 3000,
    current_price: 3000,
    stop_loss_price: 2985,
    take_profit_price: 3045,
    status: "open",
    opened_at: "2026-06-22T08:00:00Z",
    broker_position_id: "bpos-1",
    ...overrides,
  });
  return stub as unknown as PaperPosition;
}

function makeConn(): BrokerConnection {
  const stub = Object.create(null) as Record<string, unknown>;
  Object.assign(stub, { id: "conn-1", provider: "metaapi" });
  return stub as unknown as BrokerConnection;
}

interface AdapterOverrides {
  fetchPositions?: ReturnType<typeof vi.fn>;
  fetchClosedDealForPosition?: ReturnType<typeof vi.fn> | undefined;
}

function makeAdapter(overrides: AdapterOverrides = {}): BrokerAdapter {
  const a = Object.create(null) as Record<string, unknown>;
  a.provider = "metaapi";
  a.fetchPositions = overrides.fetchPositions ?? vi.fn().mockResolvedValue([]);
  if ("fetchClosedDealForPosition" in overrides) {
    a.fetchClosedDealForPosition = overrides.fetchClosedDealForPosition;
  } else {
    a.fetchClosedDealForPosition = vi.fn().mockResolvedValue(null);
  }
  a.fetchAccount = vi.fn();
  a.fetchSymbolSpec = vi.fn();
  a.placeMarketOrder = vi.fn();
  a.fetchPosition = vi.fn();
  a.closePosition = vi.fn();
  a.fetchQuote = vi.fn();
  a.modifyPosition = vi.fn();
  return a as unknown as BrokerAdapter;
}

function makeBrokerCtx(adapter?: BrokerAdapter): { adapter: BrokerAdapter; conn: BrokerConnection } {
  return { adapter: adapter ?? makeAdapter(), conn: makeConn() };
}

// ---- Supabase mock — paper_positions update only. --------------------
interface UpdateCapture {
  payloads: Array<Record<string, unknown>>;
  eqCalls: Array<Array<[string, unknown]>>;
}

function makePaperUpdateMock(): {
  supabase: SupabaseClient;
  captures: UpdateCapture;
} {
  const captures: UpdateCapture = { payloads: [], eqCalls: [] };
  const fromMock = vi.fn((table: string) => {
    if (table !== "paper_positions") throw new Error(`Unexpected table: ${table}`);
    const update = vi.fn().mockImplementation((payload: Record<string, unknown>) => {
      const eqCalls: Array<[string, unknown]> = [];
      const result = { data: null, error: null };
      const builder = Object.create(null) as Record<string, unknown>;
      builder.eq = vi.fn().mockImplementation((col: string, val: unknown) => {
        eqCalls.push([col, val]);
        return builder;
      });
      builder.then = (
        onfulfilled?: (v: typeof result) => unknown,
        onrejected?: (e: unknown) => unknown
      ) => Promise.resolve(result).then(onfulfilled, onrejected);
      captures.payloads.push(payload);
      captures.eqCalls.push(eqCalls);
      return builder;
    });
    return { update };
  });
  const stub = Object.create(null) as Record<string, unknown>;
  stub.from = fromMock;
  return { supabase: stub as unknown as SupabaseClient, captures };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedLogActivity.mockResolvedValue(undefined);
});

// ======================================================================
// syncBrokerUnrealizedPnl
// ======================================================================

describe("syncBrokerUnrealizedPnl — early returns", () => {
  it("brokerCtx null → early return (no fetch, no update)", async () => {
    const adapter = makeAdapter();
    const { supabase, captures } = makePaperUpdateMock();
    await syncBrokerUnrealizedPnl(supabase, null, [makePaper()]);
    expect(adapter.fetchPositions).not.toHaveBeenCalled();
    expect(captures.payloads).toEqual([]);
  });

  it("empty positions array → early return", async () => {
    const adapter = makeAdapter();
    const { supabase, captures } = makePaperUpdateMock();
    await syncBrokerUnrealizedPnl(supabase, makeBrokerCtx(adapter), []);
    expect(adapter.fetchPositions).not.toHaveBeenCalled();
    expect(captures.payloads).toEqual([]);
  });

  it("no positions have broker_position_id → early return (paper-only)", async () => {
    const adapter = makeAdapter();
    const { supabase, captures } = makePaperUpdateMock();
    await syncBrokerUnrealizedPnl(
      supabase,
      makeBrokerCtx(adapter),
      [makePaper({ broker_position_id: null }), makePaper({ id: "pp-2", broker_position_id: null })]
    );
    expect(adapter.fetchPositions).not.toHaveBeenCalled();
    expect(captures.payloads).toEqual([]);
  });
});

describe("syncBrokerUnrealizedPnl — broker fetch failure", () => {
  it("fetchPositions throws Error → logger.warn + return (no overwrite)", async () => {
    const adapter = makeAdapter({
      fetchPositions: vi.fn().mockRejectedValue(new Error("MetaApi 500")),
    });
    const { supabase, captures } = makePaperUpdateMock();
    await syncBrokerUnrealizedPnl(supabase, makeBrokerCtx(adapter), [makePaper()]);
    expect(captures.payloads).toEqual([]); // no overwrite — stale > nulled
    expect(mockedLogger.warn).toHaveBeenCalledWith(
      "manage-positions",
      "broker fetchPositions failed, leaving broker_unrealized_pnl stale",
      "MetaApi 500"
    );
  });

  it("fetchPositions throws non-Error → logger.warn passes raw value", async () => {
    const adapter = makeAdapter({
      fetchPositions: vi.fn().mockRejectedValue({ rawObject: true }),
    });
    const { supabase } = makePaperUpdateMock();
    await syncBrokerUnrealizedPnl(supabase, makeBrokerCtx(adapter), [makePaper()]);
    expect(mockedLogger.warn).toHaveBeenCalledWith(
      "manage-positions",
      "broker fetchPositions failed, leaving broker_unrealized_pnl stale",
      { rawObject: true }
    );
  });
});

describe("syncBrokerUnrealizedPnl — per-position sync", () => {
  it("position present on broker → UPDATE broker_unrealized_pnl + synced_at ISO", async () => {
    const adapter = makeAdapter({
      fetchPositions: vi.fn().mockResolvedValue([{ id: "bpos-1", profit: 125.75 }]),
    });
    const { supabase, captures } = makePaperUpdateMock();
    await syncBrokerUnrealizedPnl(
      supabase,
      makeBrokerCtx(adapter),
      [makePaper({ broker_position_id: "bpos-1" })]
    );
    expect(captures.payloads).toHaveLength(1);
    expect(captures.payloads[0].broker_unrealized_pnl).toBe(125.75);
    expect(typeof captures.payloads[0].broker_pnl_synced_at).toBe("string");
    expect(captures.eqCalls[0]).toEqual([["id", "pp-1"]]);
  });

  it("broker.profit = null/undefined → coerced to 0 (defensive Number() ?? 0)", async () => {
    const adapter = makeAdapter({
      fetchPositions: vi.fn().mockResolvedValue([{ id: "bpos-1", profit: null }]),
    });
    const { supabase, captures } = makePaperUpdateMock();
    await syncBrokerUnrealizedPnl(
      supabase,
      makeBrokerCtx(adapter),
      [makePaper({ broker_position_id: "bpos-1" })]
    );
    expect(captures.payloads[0].broker_unrealized_pnl).toBe(0);
  });

  it("multiple mirrored positions → each updated independently", async () => {
    const adapter = makeAdapter({
      fetchPositions: vi.fn().mockResolvedValue([
        { id: "bpos-1", profit: 100 },
        { id: "bpos-2", profit: -50 },
      ]),
    });
    const { supabase, captures } = makePaperUpdateMock();
    await syncBrokerUnrealizedPnl(
      supabase,
      makeBrokerCtx(adapter),
      [
        makePaper({ id: "pp-1", broker_position_id: "bpos-1" }),
        makePaper({ id: "pp-2", broker_position_id: "bpos-2" }),
      ]
    );
    expect(captures.payloads).toHaveLength(2);
    expect(captures.payloads.map((p) => p.broker_unrealized_pnl)).toEqual([100, -50]);
    expect(captures.eqCalls.map((c) => c[0][1])).toEqual(["pp-1", "pp-2"]);
  });
});

describe("syncBrokerUnrealizedPnl — missing-from-broker reconciliation", () => {
  it("position MISSING from broker fetch → reconcileMissingBrokerPosition called (via fetchClosedDealForPosition)", async () => {
    const closedDealFetcher = vi.fn().mockResolvedValue(null); // deal not yet settled
    const adapter = makeAdapter({
      fetchPositions: vi.fn().mockResolvedValue([]), // broker reports no positions
      fetchClosedDealForPosition: closedDealFetcher,
    });
    const { supabase, captures } = makePaperUpdateMock();
    await syncBrokerUnrealizedPnl(
      supabase,
      makeBrokerCtx(adapter),
      [makePaper({ broker_position_id: "bpos-missing" })]
    );
    // fetchClosedDealForPosition was called → reconcile path entered
    expect(closedDealFetcher).toHaveBeenCalledWith(expect.any(Object), "bpos-missing");
    // No update because deal hadn't settled (fetcher returned null)
    expect(captures.payloads).toEqual([]);
  });

  it("mix of present + missing → present gets UPDATE, missing gets reconcile", async () => {
    const closedDealFetcher = vi.fn().mockResolvedValue(null);
    const adapter = makeAdapter({
      fetchPositions: vi.fn().mockResolvedValue([{ id: "bpos-1", profit: 75 }]),
      fetchClosedDealForPosition: closedDealFetcher,
    });
    const { supabase, captures } = makePaperUpdateMock();
    await syncBrokerUnrealizedPnl(
      supabase,
      makeBrokerCtx(adapter),
      [
        makePaper({ id: "pp-present", broker_position_id: "bpos-1" }),
        makePaper({ id: "pp-missing", broker_position_id: "bpos-missing" }),
      ]
    );
    // pp-present got an UPDATE; pp-missing went through reconcile
    expect(captures.payloads).toHaveLength(1);
    expect(captures.eqCalls[0]).toEqual([["id", "pp-present"]]);
    expect(closedDealFetcher).toHaveBeenCalledWith(expect.any(Object), "bpos-missing");
  });
});

// ======================================================================
// reconcileMissingBrokerPosition
// ======================================================================

describe("reconcileMissingBrokerPosition — early returns", () => {
  it("adapter without fetchClosedDealForPosition → early return", async () => {
    const adapter = makeAdapter({ fetchClosedDealForPosition: undefined });
    const { supabase, captures } = makePaperUpdateMock();
    await reconcileMissingBrokerPosition(supabase, makeBrokerCtx(adapter), makePaper());
    expect(captures.payloads).toEqual([]);
    expect(mockedLogActivity).not.toHaveBeenCalled();
  });

  it("paper.broker_position_id null → early return (no fetch, no update)", async () => {
    const closedDealFetcher = vi.fn();
    const adapter = makeAdapter({ fetchClosedDealForPosition: closedDealFetcher });
    const { supabase, captures } = makePaperUpdateMock();
    await reconcileMissingBrokerPosition(
      supabase,
      makeBrokerCtx(adapter),
      makePaper({ broker_position_id: null })
    );
    expect(closedDealFetcher).not.toHaveBeenCalled();
    expect(captures.payloads).toEqual([]);
  });

  it("fetcher returns null (deal not yet settled) → no update, no log", async () => {
    const adapter = makeAdapter({
      fetchClosedDealForPosition: vi.fn().mockResolvedValue(null),
    });
    const { supabase, captures } = makePaperUpdateMock();
    await reconcileMissingBrokerPosition(supabase, makeBrokerCtx(adapter), makePaper());
    expect(captures.payloads).toEqual([]);
    expect(mockedLogActivity).not.toHaveBeenCalled();
  });
});

describe("reconcileMissingBrokerPosition — exit_reason classification", () => {
  it("exit_reason='stop_loss' when close price ≈ SL (within 0.1% tolerance)", async () => {
    // SL=2985, close=2986.5 → diff 1.5 vs tolerance 0.1% × 2986.5 = 2.987 → within
    const adapter = makeAdapter({
      fetchClosedDealForPosition: vi
        .fn()
        .mockResolvedValue({ price: 2986.5, realizedPnl: -150, closedAt: "2026-06-22T11:00:00Z" }),
    });
    const { supabase, captures } = makePaperUpdateMock();
    await reconcileMissingBrokerPosition(
      supabase,
      makeBrokerCtx(adapter),
      makePaper({ stop_loss_price: 2985, take_profit_price: 3045 })
    );
    expect(captures.payloads[0].exit_reason).toBe("stop_loss");
  });

  it("exit_reason='take_profit' when close price ≈ TP", async () => {
    // TP=3045, close=3044.5 → diff 0.5 vs tolerance 0.1% × 3044.5 = 3.044 → within
    const adapter = makeAdapter({
      fetchClosedDealForPosition: vi
        .fn()
        .mockResolvedValue({ price: 3044.5, realizedPnl: 150, closedAt: "2026-06-22T11:00:00Z" }),
    });
    const { supabase, captures } = makePaperUpdateMock();
    await reconcileMissingBrokerPosition(
      supabase,
      makeBrokerCtx(adapter),
      makePaper({ stop_loss_price: 2985, take_profit_price: 3045 })
    );
    expect(captures.payloads[0].exit_reason).toBe("take_profit");
  });

  it("exit_reason='manual' when close price matches neither SL nor TP", async () => {
    const adapter = makeAdapter({
      fetchClosedDealForPosition: vi
        .fn()
        .mockResolvedValue({ price: 3015, realizedPnl: 50, closedAt: "2026-06-22T11:00:00Z" }),
    });
    const { supabase, captures } = makePaperUpdateMock();
    await reconcileMissingBrokerPosition(
      supabase,
      makeBrokerCtx(adapter),
      makePaper({ stop_loss_price: 2985, take_profit_price: 3045 })
    );
    expect(captures.payloads[0].exit_reason).toBe("manual");
  });

  it("SL takes precedence over TP when both within tolerance (degenerate edge)", async () => {
    // Set SL and TP both at 3000; close at 3000 → both match. SL wins (first if).
    const adapter = makeAdapter({
      fetchClosedDealForPosition: vi
        .fn()
        .mockResolvedValue({ price: 3000, realizedPnl: 0, closedAt: "2026-06-22T11:00:00Z" }),
    });
    const { supabase, captures } = makePaperUpdateMock();
    await reconcileMissingBrokerPosition(
      supabase,
      makeBrokerCtx(adapter),
      makePaper({ stop_loss_price: 3000, take_profit_price: 3000 })
    );
    expect(captures.payloads[0].exit_reason).toBe("stop_loss");
  });

  it("Tolerance is 0.1% of CLOSE PRICE, not target price", async () => {
    // close=3000, tolerance = 3.0. SL=2997 → diff 3.0 → AT tolerance → matches (Math.abs ≤)
    const adapter = makeAdapter({
      fetchClosedDealForPosition: vi
        .fn()
        .mockResolvedValue({ price: 3000, realizedPnl: -30, closedAt: "2026-06-22T11:00:00Z" }),
    });
    const { supabase, captures } = makePaperUpdateMock();
    await reconcileMissingBrokerPosition(
      supabase,
      makeBrokerCtx(adapter),
      makePaper({ stop_loss_price: 2997, take_profit_price: 3045 })
    );
    expect(captures.payloads[0].exit_reason).toBe("stop_loss");
  });

  it("SL/TP null in paper row → silently skipped in classification (manual fallback)", async () => {
    const adapter = makeAdapter({
      fetchClosedDealForPosition: vi
        .fn()
        .mockResolvedValue({ price: 3000, realizedPnl: 0, closedAt: "2026-06-22T11:00:00Z" }),
    });
    const { supabase, captures } = makePaperUpdateMock();
    await reconcileMissingBrokerPosition(
      supabase,
      makeBrokerCtx(adapter),
      makePaper({ stop_loss_price: null, take_profit_price: null })
    );
    expect(captures.payloads[0].exit_reason).toBe("manual");
  });
});

describe("reconcileMissingBrokerPosition — paper-close payload + audit", () => {
  it(".eq('status', 'open') guard applied (race-safe against concurrent close)", async () => {
    const adapter = makeAdapter({
      fetchClosedDealForPosition: vi
        .fn()
        .mockResolvedValue({ price: 3045, realizedPnl: 150, closedAt: "2026-06-22T11:00:00Z" }),
    });
    const { supabase, captures } = makePaperUpdateMock();
    await reconcileMissingBrokerPosition(
      supabase,
      makeBrokerCtx(adapter),
      makePaper({ id: "pp-XYZ", take_profit_price: 3045 })
    );
    expect(captures.eqCalls[0]).toEqual([
      ["id", "pp-XYZ"],
      ["status", "open"], // guard
    ]);
  });

  it("UPDATE payload carries all 7 broker-truth fields", async () => {
    const adapter = makeAdapter({
      fetchClosedDealForPosition: vi
        .fn()
        .mockResolvedValue({ price: 3044.5, realizedPnl: 145, closedAt: "2026-06-22T11:30:00Z" }),
    });
    const { supabase, captures } = makePaperUpdateMock();
    await reconcileMissingBrokerPosition(
      supabase,
      makeBrokerCtx(adapter),
      makePaper({ take_profit_price: 3045 })
    );
    expect(captures.payloads[0]).toEqual({
      status: "closed",
      exit_price: 3044.5,
      exit_reason: "take_profit",
      realized_pnl: 145,
      broker_close_price: 3044.5,
      broker_unrealized_pnl: 0, // always zeroed at close
      closed_at: "2026-06-22T11:30:00Z",
    });
  });

  it("logActivity event_type='live_order_closed' + classified exit_reason in details", async () => {
    const adapter = makeAdapter({
      fetchClosedDealForPosition: vi
        .fn()
        .mockResolvedValue({ price: 3044.5, realizedPnl: 145, closedAt: "2026-06-22T11:30:00Z" }),
    });
    const { supabase } = makePaperUpdateMock();
    await reconcileMissingBrokerPosition(
      supabase,
      makeBrokerCtx(adapter),
      makePaper({ take_profit_price: 3045 })
    );
    expect(mockedLogActivity.mock.calls[0][2]).toMatchObject({
      event_type: "live_order_closed",
      details: {
        reason: expect.stringContaining("classified as take_profit"),
        exit_price: 3044.5,
        sl_price: 2985,
        tp_price: 3045,
        realized_pnl: 145,
        closed_at: "2026-06-22T11:30:00Z",
        broker_position_id: "bpos-1",
        exit_reason: "take_profit",
      },
    });
  });

  it("Audit log uses paper.user_id + paper.algorithm_id + paper.ticker (row-level attribution)", async () => {
    const adapter = makeAdapter({
      fetchClosedDealForPosition: vi
        .fn()
        .mockResolvedValue({ price: 3000, realizedPnl: 0, closedAt: "2026-06-22T11:00:00Z" }),
    });
    const { supabase } = makePaperUpdateMock();
    await reconcileMissingBrokerPosition(
      supabase,
      makeBrokerCtx(adapter),
      makePaper({
        user_id: "user-XYZ",
        algorithm_id: "algo-XYZ",
        ticker: "EUR/USD",
      })
    );
    expect(mockedLogActivity.mock.calls[0][1]).toBe("user-XYZ");
    expect(mockedLogActivity.mock.calls[0][2].algorithm_id).toBe("algo-XYZ");
    expect(mockedLogActivity.mock.calls[0][2].ticker).toBe("EUR/USD");
  });
});
