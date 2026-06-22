/**
 * Unit tests for flattenAlgorithmPositions (CB.T1 pass 14, 2026-06-22).
 * Fourteenth test in `src/lib/scan/`. Close-all helper used by:
 *   - admin /api/admin/flatten-algo escape hatch
 *   - daily-loss-limit halt (scan-side)
 *   - FTMO drawdown-breach termination (B.1.13)
 *
 * Coverage (~18 tests):
 *  Setup-path dispatch:
 *   - No algo found → empty results
 *   - Algo missing broker_connection_id → skips broker lookup, paper-only
 *   - Algo + conn but conn lookup returns null → paper-only
 *   - Algo + conn + adapter all present → routes per-position
 *
 *  Position-loop scenarios:
 *   - Empty position list → empty results
 *   - paper-only position (no broker_position_id) → status="paper-only",
 *     logActivity event_type="position_closed"
 *   - broker close succeeds → status="broker-closed",
 *     logActivity event_type="live_order_closed"
 *   - broker close throws (Error) → status="broker-failed: <msg>",
 *     logActivity event_type="live_order_close_failed"
 *   - broker close throws (non-Error) → status="broker-failed: unknown"
 *
 *  Update semantics + payload:
 *   - exitPrice = current_price when present
 *   - exitPrice = entry_price fallback when current_price null
 *   - realized_pnl = unrealized_pnl when present
 *   - realized_pnl = 0 when unrealized null
 *   - Paper update applies .eq("status", "open") guard (no overwrite
 *     of mid-flatten already-closed rows)
 *   - closeUpdate carries all 6 fields (status, exit_price,
 *     unrealized_pnl:0, realized_pnl, exit_reason, closed_at ISO)
 *   - exitReason defaults to "manual" when omitted
 *   - exitReason passed through (custom string)
 *
 *  Mixed scenarios + audit:
 *   - Multiple positions: each gets independent status + log entry
 *   - logActivity details include source:"flatten" + status + reason +
 *     exit_price + realized_pnl (audit completeness)
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getBrokerAdapter } from "@/lib/brokers/registry";
import type { BrokerAdapter, BrokerConnection } from "@/lib/brokers/types";
import { flattenAlgorithmPositions } from "./flatten";
import { logActivity } from "./helpers";
import type { SupabaseClient } from "@supabase/supabase-js";

// ---- Mocks. -----------------------------------------------------------
vi.mock("@/lib/brokers/registry", () => ({
  getBrokerAdapter: vi.fn(),
}));
vi.mock("./helpers", () => ({
  logActivity: vi.fn(),
}));

const mockedGetBrokerAdapter = vi.mocked(getBrokerAdapter);
const mockedLogActivity = vi.mocked(logActivity);

// ---- Supabase mock — table-dispatching with update + select paths. ----
type PosRow = {
  id: string;
  user_id: string;
  ticker: string;
  entry_price: number;
  current_price: number | null;
  realized_pnl: number | null;
  unrealized_pnl: number | null;
  broker_position_id: string | null;
};

interface SupabaseFlattenMockInputs {
  algoData?: { broker_connection_id: string | null } | null;
  connData?: BrokerConnection | null;
  positions?: PosRow[];
}

interface SupabaseFlattenMockOutputs {
  supabase: SupabaseClient;
  updateCalls: Array<{ payload: Record<string, unknown>; eqCalls: Array<[string, unknown]> }>;
  positionsSelectEqCalls: Array<[string, unknown]>;
}

function makeSupabaseFlattenMock(
  inputs: SupabaseFlattenMockInputs = {}
): SupabaseFlattenMockOutputs {
  const updateCalls: Array<{
    payload: Record<string, unknown>;
    eqCalls: Array<[string, unknown]>;
  }> = [];
  const positionsSelectEqCalls: Array<[string, unknown]> = [];

  const fromMock = vi.fn((table: string) => {
    if (table === "algorithms") {
      // select → eq → single
      const single = vi.fn().mockResolvedValue({
        data: inputs.algoData === undefined ? null : inputs.algoData,
        error: null,
      });
      const eq = vi.fn().mockReturnValue({ single });
      const select = vi.fn().mockReturnValue({ eq });
      return { select };
    }
    if (table === "broker_connections") {
      const single = vi.fn().mockResolvedValue({
        data: inputs.connData ?? null,
        error: null,
      });
      const eq = vi.fn().mockReturnValue({ single });
      const select = vi.fn().mockReturnValue({ eq });
      return { select };
    }
    if (table === "paper_positions") {
      // Either .select (positions list) or .update (close one row)
      const selectEqEqResult = {
        data: inputs.positions ?? [],
        error: null,
      };
      const selectEqEqBuilder = Object.create(null) as Record<string, unknown>;
      selectEqEqBuilder.eq = vi.fn().mockImplementation((col: string, val: unknown) => {
        positionsSelectEqCalls.push([col, val]);
        return selectEqEqBuilder;
      });
      selectEqEqBuilder.then = (
        onfulfilled?: (v: typeof selectEqEqResult) => unknown,
        onrejected?: (e: unknown) => unknown
      ) => Promise.resolve(selectEqEqResult).then(onfulfilled, onrejected);
      const select = vi.fn().mockReturnValue(selectEqEqBuilder);

      const update = vi.fn().mockImplementation((payload: Record<string, unknown>) => {
        const eqCalls: Array<[string, unknown]> = [];
        const updateResult = { data: null, error: null };
        const builder = Object.create(null) as Record<string, unknown>;
        builder.eq = vi.fn().mockImplementation((col: string, val: unknown) => {
          eqCalls.push([col, val]);
          return builder;
        });
        builder.then = (
          onfulfilled?: (v: typeof updateResult) => unknown,
          onrejected?: (e: unknown) => unknown
        ) => Promise.resolve(updateResult).then(onfulfilled, onrejected);
        updateCalls.push({ payload, eqCalls });
        return builder;
      });

      return { select, update };
    }
    throw new Error(`Unexpected table: ${table}`);
  });

  const supabaseStub = Object.create(null) as Record<string, unknown>;
  supabaseStub.from = fromMock;
  return {
    supabase: supabaseStub as unknown as SupabaseClient,
    updateCalls,
    positionsSelectEqCalls,
  };
}

// ---- Fixture helpers. -------------------------------------------------
function makePos(fields: Partial<PosRow>): PosRow {
  return {
    id: "pos-1",
    user_id: "user-1",
    ticker: "XAU/USD",
    entry_price: 3000,
    current_price: 3010,
    realized_pnl: null,
    unrealized_pnl: 100,
    broker_position_id: null,
    ...fields,
  };
}

function makeAdapter(closeImpl?: () => Promise<unknown>): BrokerAdapter {
  const stub = Object.create(null) as Record<string, unknown>;
  stub.provider = "metaapi";
  stub.closePosition = vi.fn().mockImplementation(closeImpl ?? (() => Promise.resolve(undefined)));
  // Stubs for other adapter methods (not called by flatten)
  stub.fetchAccount = vi.fn();
  stub.fetchPositions = vi.fn();
  stub.openPosition = vi.fn();
  stub.fetchQuote = vi.fn();
  stub.modifyPosition = vi.fn();
  return stub as unknown as BrokerAdapter;
}

function makeConn(): BrokerConnection {
  const stub = Object.create(null) as Record<string, unknown>;
  Object.assign(stub, {
    id: "conn-1",
    user_id: "user-1",
    provider: "metaapi",
    api_token: "tok",
    account_id: "acct-1",
    region: "new-york",
    refresh_token: null,
    token_expires_at: null,
    account_login: null,
  });
  return stub as unknown as BrokerConnection;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedGetBrokerAdapter.mockReturnValue(null);
  mockedLogActivity.mockResolvedValue(undefined);
});

// ======================================================================
// Setup-path dispatch
// ======================================================================

describe("flattenAlgorithmPositions — setup-path dispatch", () => {
  it("algo not found (null data) → no positions queried, returns []", async () => {
    const { supabase } = makeSupabaseFlattenMock({ algoData: null });
    const r = await flattenAlgorithmPositions(supabase, "algo-1");
    expect(r).toEqual([]);
  });

  it("algo with broker_connection_id=null → skips broker lookup; positions still queried", async () => {
    const { supabase } = makeSupabaseFlattenMock({
      algoData: { broker_connection_id: null },
      positions: [makePos({ broker_position_id: null })],
    });
    const r = await flattenAlgorithmPositions(supabase, "algo-1");
    expect(r).toHaveLength(1);
    expect(r[0].status).toBe("paper-only");
    // No adapter resolution attempted (broker lookup skipped)
    expect(mockedGetBrokerAdapter).not.toHaveBeenCalled();
  });

  it("algo + broker_connection_id present BUT conn lookup returns null → paper-only", async () => {
    const { supabase } = makeSupabaseFlattenMock({
      algoData: { broker_connection_id: "conn-1" },
      connData: null, // conn deleted/missing
      positions: [makePos({ broker_position_id: "broker-pos-1" })],
    });
    const r = await flattenAlgorithmPositions(supabase, "algo-1");
    expect(r[0].status).toBe("paper-only");
    expect(mockedGetBrokerAdapter).not.toHaveBeenCalled();
  });

  it("algo + conn present BUT adapter is null (unregistered provider) → paper-only", async () => {
    mockedGetBrokerAdapter.mockReturnValue(null);
    const { supabase } = makeSupabaseFlattenMock({
      algoData: { broker_connection_id: "conn-1" },
      connData: makeConn(),
      positions: [makePos({ broker_position_id: "broker-pos-1" })],
    });
    const r = await flattenAlgorithmPositions(supabase, "algo-1");
    expect(r[0].status).toBe("paper-only");
    expect(mockedGetBrokerAdapter).toHaveBeenCalledWith("metaapi");
  });

  it("algo + conn + adapter all set → broker.closePosition routed for positions with broker_position_id", async () => {
    const adapter = makeAdapter();
    mockedGetBrokerAdapter.mockReturnValue(adapter);
    const { supabase } = makeSupabaseFlattenMock({
      algoData: { broker_connection_id: "conn-1" },
      connData: makeConn(),
      positions: [makePos({ broker_position_id: "broker-pos-1" })],
    });
    const r = await flattenAlgorithmPositions(supabase, "algo-1");
    expect(adapter.closePosition).toHaveBeenCalledWith(expect.any(Object), "broker-pos-1");
    expect(r[0].status).toBe("broker-closed");
  });
});

// ======================================================================
// Position-loop scenarios
// ======================================================================

describe("flattenAlgorithmPositions — position-loop scenarios", () => {
  it("empty position list → returns [], no broker calls, no paper updates", async () => {
    const adapter = makeAdapter();
    mockedGetBrokerAdapter.mockReturnValue(adapter);
    const { supabase, updateCalls } = makeSupabaseFlattenMock({
      algoData: { broker_connection_id: "conn-1" },
      connData: makeConn(),
      positions: [],
    });
    const r = await flattenAlgorithmPositions(supabase, "algo-1");
    expect(r).toEqual([]);
    expect(adapter.closePosition).not.toHaveBeenCalled();
    expect(updateCalls).toHaveLength(0);
    expect(mockedLogActivity).not.toHaveBeenCalled();
  });

  it("paper-only position (no broker_position_id) → status='paper-only', event_type='position_closed'", async () => {
    const adapter = makeAdapter();
    mockedGetBrokerAdapter.mockReturnValue(adapter);
    const { supabase } = makeSupabaseFlattenMock({
      algoData: { broker_connection_id: "conn-1" },
      connData: makeConn(),
      positions: [makePos({ broker_position_id: null })],
    });
    const r = await flattenAlgorithmPositions(supabase, "algo-1");
    expect(r[0].status).toBe("paper-only");
    expect(adapter.closePosition).not.toHaveBeenCalled();
    expect(mockedLogActivity.mock.calls[0][2].event_type).toBe("position_closed");
  });

  it("broker close succeeds → status='broker-closed', event_type='live_order_closed'", async () => {
    const adapter = makeAdapter();
    mockedGetBrokerAdapter.mockReturnValue(adapter);
    const { supabase } = makeSupabaseFlattenMock({
      algoData: { broker_connection_id: "conn-1" },
      connData: makeConn(),
      positions: [makePos({ broker_position_id: "broker-pos-1" })],
    });
    const r = await flattenAlgorithmPositions(supabase, "algo-1");
    expect(r[0].status).toBe("broker-closed");
    expect(mockedLogActivity.mock.calls[0][2].event_type).toBe("live_order_closed");
  });

  it("broker close throws Error → status='broker-failed: <msg>', event_type='live_order_close_failed'", async () => {
    const adapter = makeAdapter(() => Promise.reject(new Error("MetaApi 500 timeout")));
    mockedGetBrokerAdapter.mockReturnValue(adapter);
    const { supabase } = makeSupabaseFlattenMock({
      algoData: { broker_connection_id: "conn-1" },
      connData: makeConn(),
      positions: [makePos({ broker_position_id: "broker-pos-1" })],
    });
    const r = await flattenAlgorithmPositions(supabase, "algo-1");
    expect(r[0].status).toBe("broker-failed: MetaApi 500 timeout");
    expect(mockedLogActivity.mock.calls[0][2].event_type).toBe("live_order_close_failed");
  });

  it("broker close throws non-Error → status='broker-failed: unknown' (defensive)", async () => {
    // Throw a non-Error value (e.g. raw string from adapter SDK)
    const adapter = makeAdapter(() => Promise.reject("string thrown directly"));
    mockedGetBrokerAdapter.mockReturnValue(adapter);
    const { supabase } = makeSupabaseFlattenMock({
      algoData: { broker_connection_id: "conn-1" },
      connData: makeConn(),
      positions: [makePos({ broker_position_id: "broker-pos-1" })],
    });
    const r = await flattenAlgorithmPositions(supabase, "algo-1");
    expect(r[0].status).toBe("broker-failed: unknown");
  });
});

// ======================================================================
// Update semantics + close payload
// ======================================================================

describe("flattenAlgorithmPositions — paper close-update payload", () => {
  it("exitPrice = current_price when present", async () => {
    const { supabase, updateCalls } = makeSupabaseFlattenMock({
      algoData: { broker_connection_id: null },
      positions: [makePos({ current_price: 3025, entry_price: 3000, broker_position_id: null })],
    });
    await flattenAlgorithmPositions(supabase, "algo-1");
    expect(updateCalls[0].payload.exit_price).toBe(3025);
  });

  it("exitPrice falls back to entry_price when current_price is null", async () => {
    const { supabase, updateCalls } = makeSupabaseFlattenMock({
      algoData: { broker_connection_id: null },
      positions: [makePos({ current_price: null, entry_price: 3000, broker_position_id: null })],
    });
    await flattenAlgorithmPositions(supabase, "algo-1");
    expect(updateCalls[0].payload.exit_price).toBe(3000);
  });

  it("realized_pnl = unrealized_pnl at close time (honest snapshot)", async () => {
    const { supabase, updateCalls } = makeSupabaseFlattenMock({
      algoData: { broker_connection_id: null },
      positions: [makePos({ unrealized_pnl: 247.5, broker_position_id: null })],
    });
    await flattenAlgorithmPositions(supabase, "algo-1");
    expect(updateCalls[0].payload.realized_pnl).toBe(247.5);
  });

  it("realized_pnl = 0 when unrealized_pnl is null (never got a tick)", async () => {
    const { supabase, updateCalls } = makeSupabaseFlattenMock({
      algoData: { broker_connection_id: null },
      positions: [makePos({ unrealized_pnl: null, broker_position_id: null })],
    });
    await flattenAlgorithmPositions(supabase, "algo-1");
    expect(updateCalls[0].payload.realized_pnl).toBe(0);
  });

  it("close-update applies .eq('status', 'open') guard (don't overwrite already-closed rows)", async () => {
    const { supabase, updateCalls } = makeSupabaseFlattenMock({
      algoData: { broker_connection_id: null },
      positions: [makePos({ id: "pos-X", broker_position_id: null })],
    });
    await flattenAlgorithmPositions(supabase, "algo-1");
    // Must include status='open' filter alongside id='pos-X' — protects
    // against the race where scan/manage closes the row mid-flatten
    expect(updateCalls[0].eqCalls).toEqual([
      ["id", "pos-X"],
      ["status", "open"],
    ]);
  });

  it("closeUpdate payload includes all 6 fields with correct values", async () => {
    const { supabase, updateCalls } = makeSupabaseFlattenMock({
      algoData: { broker_connection_id: null },
      positions: [
        makePos({
          unrealized_pnl: 50,
          current_price: 3020,
          broker_position_id: null,
        }),
      ],
    });
    await flattenAlgorithmPositions(supabase, "algo-1", "ftmo_termination");
    const p = updateCalls[0].payload;
    expect(p.status).toBe("closed");
    expect(p.exit_price).toBe(3020);
    expect(p.unrealized_pnl).toBe(0); // always zeroed at close
    expect(p.realized_pnl).toBe(50);
    expect(p.exit_reason).toBe("ftmo_termination");
    // closed_at is ISO 8601 (round-tripable through Date)
    expect(typeof p.closed_at).toBe("string");
    expect(Number.isNaN(Date.parse(p.closed_at as string))).toBe(false);
  });

  it("exitReason defaults to 'manual' when omitted (admin escape hatch default)", async () => {
    const { supabase, updateCalls } = makeSupabaseFlattenMock({
      algoData: { broker_connection_id: null },
      positions: [makePos({ broker_position_id: null })],
    });
    await flattenAlgorithmPositions(supabase, "algo-1");
    expect(updateCalls[0].payload.exit_reason).toBe("manual");
  });

  it("exitReason override passes through (e.g. 'ftmo_termination', 'daily_loss_limit')", async () => {
    const { supabase, updateCalls } = makeSupabaseFlattenMock({
      algoData: { broker_connection_id: null },
      positions: [makePos({ broker_position_id: null })],
    });
    await flattenAlgorithmPositions(supabase, "algo-1", "daily_loss_limit");
    expect(updateCalls[0].payload.exit_reason).toBe("daily_loss_limit");
  });
});

// ======================================================================
// Mixed scenarios + audit completeness
// ======================================================================

describe("flattenAlgorithmPositions — mixed scenarios + audit", () => {
  it("multiple positions: each gets independent status + audit entry", async () => {
    // adapter.closePosition first call succeeds, second throws
    let n = 0;
    const adapter = makeAdapter(() => {
      n++;
      return n === 1 ? Promise.resolve(undefined) : Promise.reject(new Error("net err"));
    });
    mockedGetBrokerAdapter.mockReturnValue(adapter);
    const { supabase, updateCalls } = makeSupabaseFlattenMock({
      algoData: { broker_connection_id: "conn-1" },
      connData: makeConn(),
      positions: [
        makePos({ id: "p1", ticker: "XAU/USD", broker_position_id: "bpos-1" }),
        makePos({ id: "p2", ticker: "EUR/USD", broker_position_id: "bpos-2" }),
        makePos({ id: "p3", ticker: "GBP/USD", broker_position_id: null }), // paper-only
      ],
    });
    const r = await flattenAlgorithmPositions(supabase, "algo-1");
    expect(r).toEqual([
      { ticker: "XAU/USD", broker_position_id: "bpos-1", status: "broker-closed" },
      { ticker: "EUR/USD", broker_position_id: "bpos-2", status: "broker-failed: net err" },
      { ticker: "GBP/USD", broker_position_id: null, status: "paper-only" },
    ]);
    // Three paper updates (one per position) — all still ran even though
    // the broker call for p2 failed (intentional: paper-side close
    // mirrors what the broker SHOULD be regardless of API outcome)
    expect(updateCalls).toHaveLength(3);
    // Three audit log entries with the right event_type each
    expect(mockedLogActivity.mock.calls.map((c) => c[2].event_type)).toEqual([
      "live_order_closed",
      "live_order_close_failed",
      "position_closed",
    ]);
  });

  it("audit log details include source='flatten' + status + reason + exit_price + realized_pnl", async () => {
    const adapter = makeAdapter();
    mockedGetBrokerAdapter.mockReturnValue(adapter);
    const { supabase } = makeSupabaseFlattenMock({
      algoData: { broker_connection_id: "conn-1" },
      connData: makeConn(),
      positions: [
        makePos({
          ticker: "XAU/USD",
          broker_position_id: "bpos-1",
          current_price: 3015,
          unrealized_pnl: 75,
        }),
      ],
    });
    await flattenAlgorithmPositions(supabase, "algo-1", "daily_loss_limit");
    const logArgs = mockedLogActivity.mock.calls[0];
    expect(logArgs[2]).toMatchObject({
      algorithm_id: "algo-1",
      position_id: "pos-1",
      event_type: "live_order_closed",
      ticker: "XAU/USD",
      details: {
        source: "flatten",
        flatten_status: "broker-closed",
        exit_reason: "daily_loss_limit",
        exit_price: 3015,
        realized_pnl: 75,
      },
    });
  });
});
