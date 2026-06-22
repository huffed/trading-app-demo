/**
 * Unit tests for broker-truth-sync (CB.T1 pass 18, 2026-06-22).
 * Eighteenth test in `src/lib/scan/`. Deferred deal-reconciliation
 * pickup — the manage-cron retry layer for rows that executeLiveExit
 * left with `broker_realized_synced_at IS NULL` (deal lagged at close).
 * Completes the live-execution loop documented in pass 16.
 *
 * Coverage (~22 tests):
 *  reconcileBrokerRealizedPnl:
 *   - Adapter without fetchClosedDealForPosition → early return (no DB query)
 *   - Query error → early return
 *   - Empty data → early return
 *   - Query construction: status='closed' + synced_at IS NULL +
 *     broker_position_id NOT NULL + closed_at >= 7-day cutoff +
 *     algorithm_id=arg
 *   - 7-day reconcile window: cutoff date is approx now - 7 days (ISO)
 *   - Row with null broker_position_id (defensive) SKIPPED in loop
 *   - Fetcher returns null → row left alone (no update, no log)
 *   - Fetcher throws → row left alone, loop continues
 *   - Fetcher returns deal → UPDATE broker_close_price + realized_pnl +
 *     broker_realized_synced_at; targets .eq("id", row.id)
 *   - logActivity 'broker_realized_synced' with 4 audit detail fields
 *   - Multiple rows: one fetcher throw doesn't stop subsequent rows
 *   - User ID is row-level (not algo-level) — each log carries
 *     row.user_id (matches paper_positions ownership)
 *
 *  reconcileOrphanBrokerRealized:
 *   - alreadyHandled algos SKIPPED
 *   - Duplicate algorithm_id rows deduped via seen-set
 *   - Query filters paper_positions joined with algorithms!inner where
 *     algorithms.status='active' + synced_at IS NULL + broker_position_id NOT NULL
 *   - algorithms relation as OBJECT → unwrap
 *   - algorithms relation as ARRAY → unwrap [0]
 *   - resolveBrokerContext called per algo with (user_id, broker_id, live_enabled)
 *   - resolveBrokerContext returns null (paper-only) → skip algo
 *   - resolveBrokerContext returns ctx → reconcile delegated
 *   - Query error → early return
 *   - Empty data → early return
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  reconcileBrokerRealizedPnl,
  reconcileOrphanBrokerRealized,
} from "./broker-truth-sync";
import { logActivity } from "./helpers";
import { resolveBrokerContext } from "./live-execution";
import type { SupabaseClient } from "@supabase/supabase-js";

// ---- Mocks. -----------------------------------------------------------
vi.mock("./helpers", () => ({
  logActivity: vi.fn(),
}));
vi.mock("./live-execution", () => ({
  resolveBrokerContext: vi.fn(),
}));

const mockedLogActivity = vi.mocked(logActivity);
const mockedResolveBrokerCtx = vi.mocked(resolveBrokerContext);

// ---- Fixture builders. ------------------------------------------------
type PosRow = {
  id: string;
  user_id: string;
  ticker: string;
  broker_position_id: string | null;
  closed_at: string;
};

function makeBrokerCtx(opts: {
  fetcher?:
    | ((conn: unknown, posId: string) => Promise<{ price: number; realizedPnl: number; closedAt: string } | null>)
    | undefined;
} = {}): Parameters<typeof reconcileBrokerRealizedPnl>[1] {
  const adapter = Object.create(null) as Record<string, unknown>;
  if ("fetcher" in opts) {
    adapter.fetchClosedDealForPosition = opts.fetcher;
  } else {
    adapter.fetchClosedDealForPosition = vi
      .fn()
      .mockResolvedValue({ price: 3015.5, realizedPnl: 125.25, closedAt: "2026-06-22T10:00:00Z" });
  }
  const conn = Object.create(null) as Record<string, unknown>;
  Object.assign(conn, { id: "conn-1", provider: "metaapi" });
  return { adapter, conn } as unknown as Parameters<typeof reconcileBrokerRealizedPnl>[1];
}

// ---- Supabase mock for reconcileBrokerRealizedPnl. --------------------
// Chain: from(t).select(c).eq(c,v).eq(c,v).is(c,v).not(c,o,v).gte(c,v)
// Terminal .gte awaits {data, error}.
// AND: from(t).update(p).eq("id",v) — terminal eq awaits.

interface BrokerSyncCaptures {
  selectCols: string | null;
  eqCalls: Array<[string, unknown]>;
  isCalls: Array<[string, unknown]>;
  notCalls: Array<[string, string, unknown]>;
  gteCalls: Array<[string, unknown]>;
  updatePayloads: Array<Record<string, unknown>>;
  updateEqCalls: Array<Array<[string, unknown]>>;
}

function makeBrokerSyncMock(opts: {
  selectData?: PosRow[] | null;
  selectError?: { message: string } | null;
}): { supabase: SupabaseClient; captures: BrokerSyncCaptures } {
  const captures: BrokerSyncCaptures = {
    selectCols: null,
    eqCalls: [],
    isCalls: [],
    notCalls: [],
    gteCalls: [],
    updatePayloads: [],
    updateEqCalls: [],
  };
  const selectResult = {
    data: opts.selectData === undefined ? [] : opts.selectData,
    error: opts.selectError ?? null,
  };

  const fromMock = vi.fn((table: string) => {
    if (table !== "paper_positions") throw new Error(`Unexpected table: ${table}`);

    const selectBuilder = Object.create(null) as Record<string, unknown>;
    selectBuilder.eq = vi.fn().mockImplementation((col: string, val: unknown) => {
      captures.eqCalls.push([col, val]);
      return selectBuilder;
    });
    selectBuilder.is = vi.fn().mockImplementation((col: string, val: unknown) => {
      captures.isCalls.push([col, val]);
      return selectBuilder;
    });
    selectBuilder.not = vi.fn().mockImplementation((col: string, op: string, val: unknown) => {
      captures.notCalls.push([col, op, val]);
      return selectBuilder;
    });
    selectBuilder.gte = vi.fn().mockImplementation((col: string, val: unknown) => {
      captures.gteCalls.push([col, val]);
      return Promise.resolve(selectResult);
    });
    selectBuilder.then = (
      onfulfilled?: (v: typeof selectResult) => unknown,
      onrejected?: (e: unknown) => unknown
    ) => Promise.resolve(selectResult).then(onfulfilled, onrejected);

    const select = vi.fn().mockImplementation((cols: string) => {
      captures.selectCols = cols;
      return selectBuilder;
    });

    const update = vi.fn().mockImplementation((payload: Record<string, unknown>) => {
      const eqCalls: Array<[string, unknown]> = [];
      const updateResult = { data: null, error: null };
      const builder = Object.create(null) as Record<string, unknown>;
      builder.eq = vi.fn().mockImplementation((col: string, val: unknown) => {
        eqCalls.push([col, val]);
        return Promise.resolve(updateResult);
      });
      captures.updatePayloads.push(payload);
      captures.updateEqCalls.push(eqCalls);
      return builder;
    });

    return { select, update };
  });

  const stub = Object.create(null) as Record<string, unknown>;
  stub.from = fromMock;
  return { supabase: stub as unknown as SupabaseClient, captures };
}

// ---- Supabase mock for reconcileOrphanBrokerRealized. -----------------
// Chain: from("paper_positions").select(cols).eq().is().not().gte().eq() — terminal eq awaits.

type OrphanRow = {
  algorithm_id: string;
  algorithms:
    | {
        id: string;
        user_id: string;
        status: string;
        live_trading_enabled: boolean | null;
        broker_connection_id: string | null;
      }
    | Array<{
        id: string;
        user_id: string;
        status: string;
        live_trading_enabled: boolean | null;
        broker_connection_id: string | null;
      }>
    | null;
};

function makeOrphanMock(opts: {
  selectData?: OrphanRow[] | null;
  selectError?: { message: string } | null;
}): SupabaseClient {
  const selectResult = {
    data: opts.selectData === undefined ? [] : opts.selectData,
    error: opts.selectError ?? null,
  };
  const fromMock = vi.fn((table: string) => {
    if (table !== "paper_positions") throw new Error(`Unexpected table: ${table}`);
    const builder = Object.create(null) as Record<string, unknown>;
    builder.eq = vi.fn().mockImplementation(() => builder);
    builder.is = vi.fn().mockImplementation(() => builder);
    builder.not = vi.fn().mockImplementation(() => builder);
    builder.gte = vi.fn().mockImplementation(() => builder);
    builder.then = (
      onfulfilled?: (v: typeof selectResult) => unknown,
      onrejected?: (e: unknown) => unknown
    ) => Promise.resolve(selectResult).then(onfulfilled, onrejected);
    const select = vi.fn().mockReturnValue(builder);
    return { select };
  });
  const stub = Object.create(null) as Record<string, unknown>;
  stub.from = fromMock;
  return stub as unknown as SupabaseClient;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedLogActivity.mockResolvedValue(undefined);
  mockedResolveBrokerCtx.mockResolvedValue(null);
});

// ======================================================================
// reconcileBrokerRealizedPnl
// ======================================================================

describe("reconcileBrokerRealizedPnl — early returns", () => {
  it("adapter without fetchClosedDealForPosition → early return (no DB query)", async () => {
    const throwingSupabase = Object.create(null) as Record<string, unknown>;
    throwingSupabase.from = vi.fn(() => {
      throw new Error("supabase should not be called");
    });
    const ctx = makeBrokerCtx({ fetcher: undefined });
    await reconcileBrokerRealizedPnl(
      throwingSupabase as unknown as SupabaseClient,
      ctx,
      "algo-1"
    );
    // No throw — function returned cleanly
  });

  it("query error → early return (no updates)", async () => {
    const { supabase, captures } = makeBrokerSyncMock({
      selectData: null,
      selectError: { message: "permission denied" },
    });
    await reconcileBrokerRealizedPnl(supabase, makeBrokerCtx(), "algo-1");
    expect(captures.updatePayloads).toEqual([]);
    expect(mockedLogActivity).not.toHaveBeenCalled();
  });

  it("empty data → early return (no updates)", async () => {
    const { supabase, captures } = makeBrokerSyncMock({ selectData: [] });
    await reconcileBrokerRealizedPnl(supabase, makeBrokerCtx(), "algo-1");
    expect(captures.updatePayloads).toEqual([]);
    expect(mockedLogActivity).not.toHaveBeenCalled();
  });
});

describe("reconcileBrokerRealizedPnl — query construction", () => {
  it("queries paper_positions with all 5 filters (algorithm_id, status, synced_at, position_id, cutoff)", async () => {
    const { supabase, captures } = makeBrokerSyncMock({ selectData: [] });
    await reconcileBrokerRealizedPnl(supabase, makeBrokerCtx(), "algo-XYZ");
    expect(captures.selectCols).toBe("id, user_id, ticker, broker_position_id, closed_at");
    expect(captures.eqCalls).toEqual([
      ["algorithm_id", "algo-XYZ"],
      ["status", "closed"],
    ]);
    expect(captures.isCalls).toEqual([["broker_realized_synced_at", null]]);
    expect(captures.notCalls).toEqual([["broker_position_id", "is", null]]);
    expect(captures.gteCalls).toHaveLength(1);
    expect(captures.gteCalls[0][0]).toBe("closed_at");
  });

  it("cutoff is ~ now - 7 days (RECONCILE_WINDOW_MS)", async () => {
    const { supabase, captures } = makeBrokerSyncMock({ selectData: [] });
    await reconcileBrokerRealizedPnl(supabase, makeBrokerCtx(), "algo-1");
    const cutoffIso = captures.gteCalls[0][1] as string;
    const cutoffMs = Date.parse(cutoffIso);
    const expectedMs = Date.now() - 7 * 86_400_000;
    // Within ±5s tolerance
    expect(Math.abs(cutoffMs - expectedMs)).toBeLessThan(5_000);
  });
});

describe("reconcileBrokerRealizedPnl — per-row reconciliation", () => {
  it("fetcher returns deal → UPDATE broker_close_price + realized_pnl + synced_at; targets .eq('id', row.id)", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      price: 3015.5,
      realizedPnl: 125.25,
      closedAt: "2026-06-22T10:00:00Z",
    });
    const { supabase, captures } = makeBrokerSyncMock({
      selectData: [
        {
          id: "pos-XYZ",
          user_id: "user-1",
          ticker: "XAU/USD",
          broker_position_id: "bpos-1",
          closed_at: "2026-06-22T09:00:00Z",
        },
      ],
    });
    await reconcileBrokerRealizedPnl(supabase, makeBrokerCtx({ fetcher }), "algo-1");
    expect(captures.updatePayloads).toHaveLength(1);
    expect(captures.updatePayloads[0]).toMatchObject({
      broker_close_price: 3015.5,
      realized_pnl: 125.25,
    });
    expect(captures.updatePayloads[0].broker_realized_synced_at).toEqual(expect.any(String));
    expect(captures.updateEqCalls[0]).toEqual([["id", "pos-XYZ"]]);
  });

  it("logActivity 'broker_realized_synced' carries 4 audit detail fields + row.user_id", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      price: 3015.5,
      realizedPnl: 125.25,
      closedAt: "2026-06-22T10:00:00Z",
    });
    const { supabase } = makeBrokerSyncMock({
      selectData: [
        {
          id: "pos-1",
          user_id: "user-XYZ",
          ticker: "EUR/USD",
          broker_position_id: "bpos-1",
          closed_at: "2026-06-22T09:00:00Z",
        },
      ],
    });
    await reconcileBrokerRealizedPnl(supabase, makeBrokerCtx({ fetcher }), "algo-1");
    // logActivity(supabase, userId, entry) — userId is row-level (paper_positions ownership)
    expect(mockedLogActivity.mock.calls[0][1]).toBe("user-XYZ");
    expect(mockedLogActivity.mock.calls[0][2]).toMatchObject({
      algorithm_id: "algo-1",
      position_id: "pos-1",
      event_type: "broker_realized_synced",
      ticker: "EUR/USD",
      details: {
        broker_position_id: "bpos-1",
        broker_close_price: 3015.5,
        broker_realized_pnl: 125.25,
        closed_at: "2026-06-22T10:00:00Z",
      },
    });
  });

  it("fetcher returns null (deal still hasn't settled) → row left alone, no update, no log", async () => {
    const fetcher = vi.fn().mockResolvedValue(null);
    const { supabase, captures } = makeBrokerSyncMock({
      selectData: [
        {
          id: "pos-1",
          user_id: "user-1",
          ticker: "XAU/USD",
          broker_position_id: "bpos-1",
          closed_at: "2026-06-22T09:00:00Z",
        },
      ],
    });
    await reconcileBrokerRealizedPnl(supabase, makeBrokerCtx({ fetcher }), "algo-1");
    expect(captures.updatePayloads).toEqual([]);
    expect(mockedLogActivity).not.toHaveBeenCalled();
  });

  it("fetcher throws (network blip) → row left alone, loop continues", async () => {
    const fetcher = vi
      .fn()
      // First row throws
      .mockRejectedValueOnce(new Error("broker timeout"))
      // Second row succeeds
      .mockResolvedValueOnce({
        price: 3010,
        realizedPnl: 50,
        closedAt: "2026-06-22T10:00:00Z",
      });
    const { supabase, captures } = makeBrokerSyncMock({
      selectData: [
        {
          id: "pos-1",
          user_id: "user-1",
          ticker: "XAU/USD",
          broker_position_id: "bpos-1",
          closed_at: "2026-06-22T09:00:00Z",
        },
        {
          id: "pos-2",
          user_id: "user-1",
          ticker: "EUR/USD",
          broker_position_id: "bpos-2",
          closed_at: "2026-06-22T09:30:00Z",
        },
      ],
    });
    await reconcileBrokerRealizedPnl(supabase, makeBrokerCtx({ fetcher }), "algo-1");
    // Only the second row updates (first threw)
    expect(captures.updatePayloads).toHaveLength(1);
    expect(captures.updateEqCalls[0]).toEqual([["id", "pos-2"]]);
  });

  it("row with null broker_position_id (defensive — shouldn't appear given .not query) SKIPPED in loop", async () => {
    const fetcher = vi.fn();
    const { supabase, captures } = makeBrokerSyncMock({
      selectData: [
        {
          id: "pos-1",
          user_id: "user-1",
          ticker: "XAU/USD",
          broker_position_id: null, // defensive
          closed_at: "2026-06-22T09:00:00Z",
        },
      ],
    });
    await reconcileBrokerRealizedPnl(supabase, makeBrokerCtx({ fetcher }), "algo-1");
    expect(fetcher).not.toHaveBeenCalled();
    expect(captures.updatePayloads).toEqual([]);
  });
});

// ======================================================================
// reconcileOrphanBrokerRealized
// ======================================================================

describe("reconcileOrphanBrokerRealized", () => {
  it("query error → early return (no algos visited)", async () => {
    const supabase = makeOrphanMock({
      selectData: null,
      selectError: { message: "permission denied" },
    });
    await reconcileOrphanBrokerRealized(supabase, new Set());
    expect(mockedResolveBrokerCtx).not.toHaveBeenCalled();
  });

  it("empty data → early return", async () => {
    const supabase = makeOrphanMock({ selectData: [] });
    await reconcileOrphanBrokerRealized(supabase, new Set());
    expect(mockedResolveBrokerCtx).not.toHaveBeenCalled();
  });

  it("algos in alreadyHandled set SKIPPED (avoids double-work after open-position loop)", async () => {
    const supabase = makeOrphanMock({
      selectData: [
        {
          algorithm_id: "algo-skip",
          algorithms: {
            id: "algo-skip",
            user_id: "user-1",
            status: "active",
            live_trading_enabled: true,
            broker_connection_id: "conn-1",
          },
        },
      ],
    });
    await reconcileOrphanBrokerRealized(supabase, new Set(["algo-skip"]));
    expect(mockedResolveBrokerCtx).not.toHaveBeenCalled();
  });

  it("duplicate algorithm_id rows deduped via seen-set (one resolve per algo)", async () => {
    const algo = {
      id: "algo-1",
      user_id: "user-1",
      status: "active",
      live_trading_enabled: true,
      broker_connection_id: "conn-1",
    };
    const supabase = makeOrphanMock({
      selectData: [
        { algorithm_id: "algo-1", algorithms: algo },
        { algorithm_id: "algo-1", algorithms: algo }, // duplicate
        { algorithm_id: "algo-1", algorithms: algo }, // duplicate
      ],
    });
    mockedResolveBrokerCtx.mockResolvedValue(null); // null = skipped
    await reconcileOrphanBrokerRealized(supabase, new Set());
    // Resolve called exactly once despite 3 rows for same algo
    expect(mockedResolveBrokerCtx).toHaveBeenCalledTimes(1);
  });

  it("algorithms relation as OBJECT → unwrapped correctly", async () => {
    const supabase = makeOrphanMock({
      selectData: [
        {
          algorithm_id: "algo-1",
          algorithms: {
            id: "algo-1",
            user_id: "user-1",
            status: "active",
            live_trading_enabled: true,
            broker_connection_id: "conn-1",
          },
        },
      ],
    });
    await reconcileOrphanBrokerRealized(supabase, new Set());
    expect(mockedResolveBrokerCtx).toHaveBeenCalledWith(
      expect.anything(),
      "user-1",
      "conn-1",
      true
    );
  });

  it("algorithms relation as ARRAY → first element unwrapped", async () => {
    const supabase = makeOrphanMock({
      selectData: [
        {
          algorithm_id: "algo-1",
          algorithms: [
            {
              id: "algo-1",
              user_id: "user-2",
              status: "active",
              live_trading_enabled: true,
              broker_connection_id: "conn-2",
            },
          ],
        },
      ],
    });
    await reconcileOrphanBrokerRealized(supabase, new Set());
    expect(mockedResolveBrokerCtx).toHaveBeenCalledWith(
      expect.anything(),
      "user-2",
      "conn-2",
      true
    );
  });

  it("algorithms relation null (defensive) → algo skipped", async () => {
    const supabase = makeOrphanMock({
      selectData: [{ algorithm_id: "algo-1", algorithms: null }],
    });
    await reconcileOrphanBrokerRealized(supabase, new Set());
    expect(mockedResolveBrokerCtx).not.toHaveBeenCalled();
  });

  it("resolveBrokerContext returns null (paper-only / disabled) → algo skipped", async () => {
    mockedResolveBrokerCtx.mockResolvedValue(null);
    const supabase = makeOrphanMock({
      selectData: [
        {
          algorithm_id: "algo-1",
          algorithms: {
            id: "algo-1",
            user_id: "user-1",
            status: "active",
            live_trading_enabled: false, // paper-only
            broker_connection_id: null,
          },
        },
      ],
    });
    await reconcileOrphanBrokerRealized(supabase, new Set());
    // Resolve called once (with live_enabled=false), returned null, algo skipped
    expect(mockedResolveBrokerCtx).toHaveBeenCalledTimes(1);
    // No further reconciliation triggered for this algo (mocked fetcher never called)
  });

  it("live_trading_enabled=null defaults to false in resolveBrokerContext call", async () => {
    mockedResolveBrokerCtx.mockResolvedValue(null);
    const supabase = makeOrphanMock({
      selectData: [
        {
          algorithm_id: "algo-1",
          algorithms: {
            id: "algo-1",
            user_id: "user-1",
            status: "active",
            live_trading_enabled: null, // null → ?? false
            broker_connection_id: "conn-1",
          },
        },
      ],
    });
    await reconcileOrphanBrokerRealized(supabase, new Set());
    expect(mockedResolveBrokerCtx).toHaveBeenCalledWith(
      expect.anything(),
      "user-1",
      "conn-1",
      false // defaulted from null
    );
  });
});
