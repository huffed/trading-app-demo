/**
 * Unit tests for live-execution (CB.T1 pass 16, 2026-06-22).
 * Sixteenth test in `src/lib/scan/`. Tests the 3 exports:
 *   - resolveBrokerContext (broker conn lookup + adapter routing)
 *   - executeLiveEntry (place order + 30× position-size sanity gate
 *     + paper update + audit; rollback on broker reject)
 *   - executeLiveExit (close + deferred deal reconciliation + audit)
 *
 * Coverage (~28 tests):
 *  resolveBrokerContext:
 *   - liveEnabled=false → null (no DB query)
 *   - algoBrokerId=null → null
 *   - conn status='disabled' → null
 *   - Adapter not registered for provider → null + logger.warn (anti-silent-fallback)
 *   - Happy path → {adapter, conn}
 *
 *  executeLiveEntry — lot sizing dispatch:
 *   - args.lots provided → floored to volumeStep
 *   - lots clamped to [minVolume, maxVolume]
 *   - args.lots omitted → notionalToLots derives
 *   - lots ≤ 0 → throws → broker_rejected close + voided:true
 *
 *  executeLiveEntry — position-size sanity gate:
 *   - impliedNotional > 30× capital → REFUSES (the CHF/JPY 67× backstop)
 *   - Sanity gate skipped when capital ≤ 0 (defensive)
 *   - Just under 30× → allowed
 *
 *  executeLiveEntry — broker placement + paper update:
 *   - placeMarketOrder side: long → "buy", short → "sell"
 *   - SL/TP/comment threaded through
 *   - After fill: paper_positions UPDATE with all 6 fields (broker_order_id,
 *     broker_position_id, broker_fill_price, quantity, notional_value, broker_error:null)
 *   - broker_fill_price falls back to args.currentPrice when realFill is null
 *   - brokerQuantity = lots × contractSize (re-aligned to broker truth)
 *   - logActivity "live_order_placed" with full payload
 *   - maybeHaltOnDivergence invoked when rule provided
 *   - maybeHaltOnDivergence SKIPPED when rule absent
 *
 *  executeLiveEntry — broker reject rollback:
 *   - Broker throws → status='closed', exit_reason='broker_rejected',
 *     realized_pnl=0, broker_error=msg (avoids 2026-05-18 zombie position bug)
 *   - Log "live_order_failed" with voided:true
 *   - Non-Error throw → "Live order failed" message
 *
 *  executeLiveExit:
 *   - brokerPositionId=null → no-op early return
 *   - closePosition success with dealResult → broker_close_price + realized_pnl
 *     + broker_realized_synced_at populated from deal
 *   - dealResult=null → provisional broker_close_price = args.closePrice
 *   - Adapter lacks fetchClosedDealForPosition → falls through to provisional
 *   - logActivity "live_order_closed" with all 5 detail fields
 *   - Error path: paper UPDATE broker_error only + "live_close_failed" log
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getBrokerAdapter } from "@/lib/brokers/registry";
import { notionalToLots } from "@/lib/brokers/sizing";
import type { BrokerAdapter, BrokerConnection } from "@/lib/brokers/types";
import { notionalInUsd } from "@/lib/constants/markets";
import { logger } from "@/lib/logger";
import {
  checkDivergenceKill,
  haltAlgorithmForDivergence,
} from "./divergence";
import { logActivity } from "./helpers";
import {
  executeLiveEntry,
  executeLiveExit,
  resolveBrokerContext,
} from "./live-execution";
import type { SupabaseClient } from "@supabase/supabase-js";

// ---- Mocks. -----------------------------------------------------------
vi.mock("@/lib/brokers/registry", () => ({
  getBrokerAdapter: vi.fn(),
}));
vi.mock("@/lib/brokers/sizing", () => ({
  notionalToLots: vi.fn(),
}));
vi.mock("@/lib/constants/markets", () => ({
  notionalInUsd: vi.fn(),
}));
vi.mock("@/lib/logger", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));
vi.mock("./divergence", () => ({
  checkDivergenceKill: vi.fn(),
  haltAlgorithmForDivergence: vi.fn(),
}));
vi.mock("./helpers", () => ({
  logActivity: vi.fn(),
}));

const mockedGetBrokerAdapter = vi.mocked(getBrokerAdapter);
const mockedNotionalToLots = vi.mocked(notionalToLots);
const mockedNotionalInUsd = vi.mocked(notionalInUsd);
const mockedLogger = vi.mocked(logger);
const mockedCheckDivergenceKill = vi.mocked(checkDivergenceKill);
const mockedHaltForDivergence = vi.mocked(haltAlgorithmForDivergence);
const mockedLogActivity = vi.mocked(logActivity);

// ---- Adapter + connection fixtures. -----------------------------------
function makeConn(overrides: Partial<BrokerConnection> = {}): BrokerConnection {
  const stub = Object.create(null) as Record<string, unknown>;
  Object.assign(stub, {
    id: "conn-1",
    user_id: "user-1",
    provider: "metaapi",
    api_token: "tok",
    account_id: "acct-1",
    region: "new-york",
    status: "active",
    refresh_token: null,
    token_expires_at: null,
    account_login: null,
    ...overrides,
  });
  return stub as unknown as BrokerConnection;
}

interface AdapterStubs {
  fetchSymbolSpec?: ReturnType<typeof vi.fn>;
  placeMarketOrder?: ReturnType<typeof vi.fn>;
  fetchPosition?: ReturnType<typeof vi.fn>;
  closePosition?: ReturnType<typeof vi.fn>;
  fetchClosedDealForPosition?: ReturnType<typeof vi.fn> | undefined;
}

function makeAdapter(stubs: AdapterStubs = {}): BrokerAdapter {
  const a = Object.create(null) as Record<string, unknown>;
  a.provider = "metaapi";
  a.fetchSymbolSpec =
    stubs.fetchSymbolSpec ??
    vi.fn().mockResolvedValue({
      contractSize: 100,
      volumeStep: 0.01,
      minVolume: 0.01,
      maxVolume: 100,
    });
  a.placeMarketOrder =
    stubs.placeMarketOrder ??
    vi.fn().mockResolvedValue({ orderId: "ord-1", positionId: "bpos-1" });
  a.fetchPosition =
    stubs.fetchPosition ?? vi.fn().mockResolvedValue({ openPrice: 3001.5 });
  a.closePosition =
    stubs.closePosition ?? vi.fn().mockResolvedValue({ orderId: "close-ord-1" });
  // fetchClosedDealForPosition may be intentionally undefined (adapter
  // doesn't implement deferred deal reconciliation)
  if ("fetchClosedDealForPosition" in stubs) {
    a.fetchClosedDealForPosition = stubs.fetchClosedDealForPosition;
  } else {
    a.fetchClosedDealForPosition = vi
      .fn()
      .mockResolvedValue({ price: 3010.25, realizedPnl: 125.5 });
  }
  // Other adapter methods (not called by live-execution)
  a.fetchAccount = vi.fn();
  a.fetchPositions = vi.fn();
  a.fetchQuote = vi.fn();
  a.modifyPosition = vi.fn();
  return a as unknown as BrokerAdapter;
}

// ---- Supabase mocks. --------------------------------------------------
// Two patterns needed:
//   1. broker_connections.select(cols).eq(c,v).eq(c,v).single() — single-table
//   2. paper_positions.update(payload).eq("id",val) — terminal eq thenable

function makeBrokerConnSelectMock(opts: {
  data?: BrokerConnection | null;
  error?: { message: string } | null;
}): SupabaseClient {
  const single = vi.fn().mockResolvedValue({
    data: opts.data ?? null,
    error: opts.error ?? null,
  });
  const eq2 = vi.fn().mockReturnValue({ single });
  const eq1 = vi.fn().mockReturnValue({ eq: eq2 });
  const select = vi.fn().mockReturnValue({ eq: eq1 });
  const fromMock = vi.fn().mockReturnValue({ select });
  const stub = Object.create(null) as Record<string, unknown>;
  stub.from = fromMock;
  return stub as unknown as SupabaseClient;
}

interface PaperUpdateCapture {
  payloads: Array<Record<string, unknown>>;
  eqCalls: Array<Array<[string, unknown]>>;
}

function makePaperPositionsUpdateMock(): {
  supabase: SupabaseClient;
  captures: PaperUpdateCapture;
} {
  const captures: PaperUpdateCapture = { payloads: [], eqCalls: [] };
  const fromMock = vi.fn((table: string) => {
    if (table !== "paper_positions") {
      throw new Error(`Unexpected table: ${table}`);
    }
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

// ---- Defaults. --------------------------------------------------------
function defaultEntryArgs(overrides: Partial<Parameters<typeof executeLiveEntry>[0]> = {}) {
  const { supabase } = makePaperPositionsUpdateMock();
  return {
    supabase,
    userId: "user-1",
    algorithmId: "algo-12345678abcdef",
    paperPositionId: "pp-1",
    ticker: "XAU/USD",
    side: "long" as const,
    notionalUsd: 3_000,
    currentPrice: 3000,
    stopLossPrice: 2985,
    takeProfitPrice: 3045,
    ctx: { adapter: makeAdapter(), conn: makeConn() },
    capital: 100_000,
    ...overrides,
  };
}

function defaultExitArgs(overrides: Partial<Parameters<typeof executeLiveExit>[0]> = {}) {
  const { supabase } = makePaperPositionsUpdateMock();
  return {
    supabase,
    userId: "user-1",
    algorithmId: "algo-1",
    paperPositionId: "pp-1",
    ticker: "XAU/USD",
    brokerPositionId: "bpos-1",
    closePrice: 3010,
    ctx: { adapter: makeAdapter(), conn: makeConn() },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedGetBrokerAdapter.mockReturnValue(makeAdapter());
  mockedNotionalToLots.mockReturnValue(0.1);
  mockedNotionalInUsd.mockReturnValue(3_000);
  mockedCheckDivergenceKill.mockResolvedValue({
    tripped: false,
    avgBps: 0,
    samples: 0,
  });
  mockedHaltForDivergence.mockResolvedValue(undefined);
  mockedLogActivity.mockResolvedValue(undefined);
});

// ======================================================================
// resolveBrokerContext
// ======================================================================

describe("resolveBrokerContext — gates + adapter routing", () => {
  it("liveEnabled=false → null (no DB query, paper-only short-circuit)", async () => {
    // Construct a supabase that throws if used — proves no DB call
    const stub = Object.create(null) as Record<string, unknown>;
    stub.from = vi.fn(() => {
      throw new Error("supabase should not be queried");
    });
    const r = await resolveBrokerContext(
      stub as unknown as SupabaseClient,
      "user-1",
      "conn-1",
      false
    );
    expect(r).toBeNull();
  });

  it("algoBrokerId=null → null (no DB query)", async () => {
    const stub = Object.create(null) as Record<string, unknown>;
    stub.from = vi.fn(() => {
      throw new Error("supabase should not be queried");
    });
    const r = await resolveBrokerContext(
      stub as unknown as SupabaseClient,
      "user-1",
      null,
      true
    );
    expect(r).toBeNull();
  });

  it("conn status='disabled' → null (operator-paused broker)", async () => {
    const supabase = makeBrokerConnSelectMock({
      data: makeConn({ status: "disabled" }),
    });
    const r = await resolveBrokerContext(supabase, "user-1", "conn-1", true);
    expect(r).toBeNull();
  });

  it("no adapter for provider → null + logger.warn (anti-silent-fallback)", async () => {
    mockedGetBrokerAdapter.mockReturnValue(null);
    const supabase = makeBrokerConnSelectMock({
      data: makeConn({ provider: "novel_broker" }),
    });
    const r = await resolveBrokerContext(supabase, "user-1", "conn-1", true);
    expect(r).toBeNull();
    expect(mockedLogger.warn).toHaveBeenCalledWith(
      "live-execution",
      expect.stringContaining('no adapter for provider="novel_broker"')
    );
  });

  it("happy path → returns {adapter, conn}", async () => {
    const adapter = makeAdapter();
    mockedGetBrokerAdapter.mockReturnValue(adapter);
    const conn = makeConn();
    const supabase = makeBrokerConnSelectMock({ data: conn });
    const r = await resolveBrokerContext(supabase, "user-1", "conn-1", true);
    expect(r).toEqual({ adapter, conn });
  });
});

// ======================================================================
// executeLiveEntry — lot sizing dispatch
// ======================================================================

describe("executeLiveEntry — lot sizing dispatch", () => {
  it("args.lots provided → floored to volumeStep before placement", async () => {
    // volumeStep=0.01, args.lots=0.127 → floor(0.127/0.01)*0.01 = 0.12
    const adapter = makeAdapter({
      fetchSymbolSpec: vi.fn().mockResolvedValue({
        contractSize: 100,
        volumeStep: 0.01,
        minVolume: 0.01,
        maxVolume: 100,
      }),
    });
    const { supabase } = makePaperPositionsUpdateMock();
    await executeLiveEntry(
      defaultEntryArgs({
        supabase,
        lots: 0.127,
        ctx: { adapter, conn: makeConn() },
      })
    );
    const placeCall = (adapter.placeMarketOrder as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(placeCall[1].volume).toBeCloseTo(0.12, 2);
  });

  it("lots clamped to maxVolume when args.lots exceeds broker limit", async () => {
    const adapter = makeAdapter({
      fetchSymbolSpec: vi.fn().mockResolvedValue({
        contractSize: 100,
        volumeStep: 0.01,
        minVolume: 0.01,
        maxVolume: 50, // hard cap
      }),
    });
    const { supabase } = makePaperPositionsUpdateMock();
    await executeLiveEntry(
      defaultEntryArgs({
        supabase,
        lots: 500, // way above max
        ctx: { adapter, conn: makeConn() },
        capital: 1_000_000, // big enough that sanity gate doesn't fire
      })
    );
    const placeCall = (adapter.placeMarketOrder as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(placeCall[1].volume).toBe(50);
  });

  it("lots clamped UP to minVolume when args.lots below broker minimum", async () => {
    const adapter = makeAdapter({
      fetchSymbolSpec: vi.fn().mockResolvedValue({
        contractSize: 100,
        volumeStep: 0.01,
        minVolume: 0.1,
        maxVolume: 100,
      }),
    });
    const { supabase } = makePaperPositionsUpdateMock();
    await executeLiveEntry(
      defaultEntryArgs({
        supabase,
        lots: 0.001, // floor → 0, but minVolume clamp pulls UP to 0.1
        ctx: { adapter, conn: makeConn() },
      })
    );
    const placeCall = (adapter.placeMarketOrder as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(placeCall[1].volume).toBe(0.1);
  });

  it("args.lots omitted → notionalToLots derives from notional + price + spec", async () => {
    mockedNotionalToLots.mockReturnValue(0.25);
    const adapter = makeAdapter();
    const { supabase } = makePaperPositionsUpdateMock();
    await executeLiveEntry(
      defaultEntryArgs({
        supabase,
        lots: undefined,
        notionalUsd: 7_500,
        currentPrice: 3000,
        ctx: { adapter, conn: makeConn() },
      })
    );
    expect(mockedNotionalToLots).toHaveBeenCalledWith(7_500, 3000, expect.any(Object));
    const placeCall = (adapter.placeMarketOrder as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(placeCall[1].volume).toBe(0.25);
  });

  it("lots ≤ 0 → throws → paper closed with broker_rejected + voided:true", async () => {
    mockedNotionalToLots.mockReturnValue(0); // notional < minVolume edge
    const { supabase, captures } = makePaperPositionsUpdateMock();
    await executeLiveEntry(defaultEntryArgs({ supabase, lots: undefined }));
    expect(captures.payloads[0]).toMatchObject({
      status: "closed",
      exit_reason: "broker_rejected",
      realized_pnl: 0,
    });
    expect(captures.payloads[0].broker_error).toMatch(/Computed lot size 0/);
    expect(mockedLogActivity.mock.calls[0][2]).toMatchObject({
      event_type: "live_order_failed",
      details: { voided: true },
    });
  });
});

// ======================================================================
// executeLiveEntry — position-size sanity gate (CHF/JPY 67× backstop)
// ======================================================================

describe("executeLiveEntry — position-size sanity gate", () => {
  it("REFUSES when impliedNotional / capital > 30 (CHF/JPY blow-up backstop)", async () => {
    // capital=10K, impliedNotional=400K → 40× → over 30× cap
    mockedNotionalInUsd.mockReturnValue(400_000);
    const adapter = makeAdapter();
    const { supabase, captures } = makePaperPositionsUpdateMock();
    await executeLiveEntry(
      defaultEntryArgs({
        supabase,
        capital: 10_000,
        ctx: { adapter, conn: makeConn() },
        lots: 1,
      })
    );
    // Order NOT placed
    expect(adapter.placeMarketOrder).not.toHaveBeenCalled();
    // Paper closed with broker_rejected
    expect(captures.payloads[0]).toMatchObject({
      status: "closed",
      exit_reason: "broker_rejected",
    });
    // Error message includes the leverage math + grep-able marker
    expect(captures.payloads[0].broker_error).toMatch(/Position-size sanity check failed/);
    expect(captures.payloads[0].broker_error).toMatch(/40\.0× capital/);
  });

  it("ALLOWS when impliedNotional / capital just under 30 (boundary)", async () => {
    mockedNotionalInUsd.mockReturnValue(299_000); // 29.9× of 10K
    const adapter = makeAdapter();
    const { supabase } = makePaperPositionsUpdateMock();
    await executeLiveEntry(
      defaultEntryArgs({
        supabase,
        capital: 10_000,
        ctx: { adapter, conn: makeConn() },
        lots: 1,
      })
    );
    expect(adapter.placeMarketOrder).toHaveBeenCalledOnce();
  });

  it("Sanity gate SKIPPED when capital ≤ 0 (defensive — avoids div-by-zero)", async () => {
    mockedNotionalInUsd.mockReturnValue(10_000_000); // huge
    const adapter = makeAdapter();
    const { supabase } = makePaperPositionsUpdateMock();
    await executeLiveEntry(
      defaultEntryArgs({
        supabase,
        capital: 0, // edge case
        ctx: { adapter, conn: makeConn() },
        lots: 1,
      })
    );
    // Sanity gate didn't trip (capital=0 short-circuit) — order goes through
    expect(adapter.placeMarketOrder).toHaveBeenCalledOnce();
  });
});

// ======================================================================
// executeLiveEntry — broker placement + paper update
// ======================================================================

describe("executeLiveEntry — broker placement + paper update", () => {
  it("placeMarketOrder side dispatch: long → 'buy', short → 'sell'", async () => {
    const adapterLong = makeAdapter();
    await executeLiveEntry(
      defaultEntryArgs({
        side: "long",
        ctx: { adapter: adapterLong, conn: makeConn() },
        lots: 0.1,
      })
    );
    expect((adapterLong.placeMarketOrder as ReturnType<typeof vi.fn>).mock.calls[0][1].side).toBe("buy");

    const adapterShort = makeAdapter();
    await executeLiveEntry(
      defaultEntryArgs({
        side: "short",
        ctx: { adapter: adapterShort, conn: makeConn() },
        lots: 0.1,
      })
    );
    expect((adapterShort.placeMarketOrder as ReturnType<typeof vi.fn>).mock.calls[0][1].side).toBe(
      "sell"
    );
  });

  it("placeMarketOrder receives SL + TP + comment with truncated algorithmId", async () => {
    const adapter = makeAdapter();
    await executeLiveEntry(
      defaultEntryArgs({
        algorithmId: "algo-abcd1234efgh5678",
        ctx: { adapter, conn: makeConn() },
        stopLossPrice: 2985,
        takeProfitPrice: 3045,
        ticker: "XAU/USD",
        lots: 0.1,
      })
    );
    const orderArg = (adapter.placeMarketOrder as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(orderArg).toMatchObject({
      appSymbol: "XAU/USD",
      volume: 0.1,
      stopLoss: 2985,
      takeProfit: 3045,
      comment: "qt:algo-abc", // first 8 chars
    });
  });

  it("paper UPDATE on success carries all 6 broker fields", async () => {
    const { supabase, captures } = makePaperPositionsUpdateMock();
    const adapter = makeAdapter({
      fetchPosition: vi.fn().mockResolvedValue({ openPrice: 3001.5 }),
      fetchSymbolSpec: vi.fn().mockResolvedValue({
        contractSize: 100,
        volumeStep: 0.01,
        minVolume: 0.01,
        maxVolume: 100,
      }),
    });
    mockedNotionalInUsd.mockReturnValue(30_000);
    await executeLiveEntry(
      defaultEntryArgs({ supabase, lots: 0.1, ctx: { adapter, conn: makeConn() } })
    );
    expect(captures.payloads[0]).toEqual({
      broker_order_id: "ord-1",
      broker_position_id: "bpos-1",
      broker_fill_price: 3001.5, // real fill (not currentPrice)
      quantity: 10, // lots 0.1 × contractSize 100 — broker-truth re-alignment
      notional_value: 30_000,
      broker_error: null,
    });
    expect(captures.eqCalls[0]).toEqual([["id", "pp-1"]]);
  });

  it("broker_fill_price FALLS BACK to args.currentPrice when fetchPosition returns null", async () => {
    const adapter = makeAdapter({
      fetchPosition: vi.fn().mockResolvedValue(null), // adapter race — position not yet visible
    });
    const { supabase, captures } = makePaperPositionsUpdateMock();
    await executeLiveEntry(
      defaultEntryArgs({
        supabase,
        currentPrice: 3000,
        lots: 0.1,
        ctx: { adapter, conn: makeConn() },
      })
    );
    expect(captures.payloads[0].broker_fill_price).toBe(3000);
  });

  it("brokerQuantity = lots × contractSize (snap to broker's truth, not paper intent)", async () => {
    // Paper intended 0.125 lots (12_500 base units @ contractSize 100k for FX),
    // but volumeStep=0.01 → floored to 0.12 → broker actually places 12_000
    // base units. Paper must snap to that, otherwise FTMO's reported P&L
    // won't match algo's reported P&L.
    const adapter = makeAdapter({
      fetchSymbolSpec: vi.fn().mockResolvedValue({
        contractSize: 100_000, // forex
        volumeStep: 0.01,
        minVolume: 0.01,
        maxVolume: 100,
      }),
    });
    const { supabase, captures } = makePaperPositionsUpdateMock();
    mockedNotionalInUsd.mockReturnValue(12_000);
    await executeLiveEntry(
      defaultEntryArgs({
        supabase,
        lots: 0.125, // floor to 0.12
        ctx: { adapter, conn: makeConn() },
        ticker: "EUR/USD",
        capital: 100_000,
      })
    );
    expect(captures.payloads[0].quantity).toBe(0.12 * 100_000); // = 12_000
  });

  it("logActivity 'live_order_placed' carries broker_order_id + broker_position_id + volume + side", async () => {
    const adapter = makeAdapter();
    await executeLiveEntry(
      defaultEntryArgs({
        side: "short",
        lots: 0.1,
        ctx: { adapter, conn: makeConn() },
      })
    );
    expect(mockedLogActivity.mock.calls[0][2]).toMatchObject({
      event_type: "live_order_placed",
      ticker: "XAU/USD",
      details: {
        broker_order_id: "ord-1",
        broker_position_id: "bpos-1",
        volume: 0.1,
        side: "short",
      },
    });
  });

  it("maybeHaltOnDivergence INVOKED when divergenceRule provided", async () => {
    await executeLiveEntry(
      defaultEntryArgs({
        lots: 0.1,
        divergenceRule: { max_avg_bps: 5, window_trades: 20 },
      })
    );
    expect(mockedCheckDivergenceKill).toHaveBeenCalledOnce();
  });

  it("maybeHaltOnDivergence SKIPPED when divergenceRule absent", async () => {
    await executeLiveEntry(defaultEntryArgs({ lots: 0.1 }));
    expect(mockedCheckDivergenceKill).not.toHaveBeenCalled();
  });

  it("haltAlgorithmForDivergence fires when divergence check trips", async () => {
    mockedCheckDivergenceKill.mockResolvedValue({
      tripped: true,
      avgBps: 7.5,
      samples: 20,
    });
    await executeLiveEntry(
      defaultEntryArgs({
        lots: 0.1,
        divergenceRule: { max_avg_bps: 5, window_trades: 20 },
      })
    );
    expect(mockedHaltForDivergence).toHaveBeenCalledOnce();
  });

  it("CB.H8: divergence helper throw AFTER successful placement does NOT void the paper position", async () => {
    // checkDivergenceKill throws — this is the bug from CB.H8. Pre-fix
    // the catch would void the (already-placed) broker position as
    // 'broker_rejected', creating silent paper↔broker desync.
    mockedCheckDivergenceKill.mockRejectedValue(new Error("divergence DB error"));
    const adapter = makeAdapter();
    const { supabase, captures } = makePaperPositionsUpdateMock();
    await executeLiveEntry(
      defaultEntryArgs({
        supabase,
        lots: 0.1,
        ctx: { adapter, conn: makeConn() },
        divergenceRule: { max_avg_bps: 5, window_trades: 20 },
      })
    );
    // Order WAS placed
    expect(adapter.placeMarketOrder).toHaveBeenCalledOnce();
    // Paper update reflects SUCCESSFUL placement, NOT broker_rejected
    expect(captures.payloads).toHaveLength(1);
    expect(captures.payloads[0]).toMatchObject({
      broker_order_id: expect.any(String),
      broker_position_id: expect.any(String),
      broker_error: null,
    });
    // Critical: paper row was NOT closed/voided
    expect(captures.payloads[0]).not.toHaveProperty("status");
    expect(captures.payloads[0]).not.toHaveProperty("exit_reason");
    // Activity log shows live_order_placed (success), NOT live_order_failed
    const events = mockedLogActivity.mock.calls.map((c) => c[2].event_type);
    expect(events).toContain("live_order_placed");
    expect(events).not.toContain("live_order_failed");
    // Divergence-helper throw was swallowed + logged via logger.warn
    expect(mockedLogger.warn).toHaveBeenCalledWith(
      "live-execution",
      expect.stringContaining("Divergence check threw after successful placement"),
      expect.any(Error)
    );
  });

  it("CB.H8: haltAlgorithmForDivergence throw also does NOT void the paper position", async () => {
    // The secondary helper (the halt itself) also runs outside the try
    mockedCheckDivergenceKill.mockResolvedValue({
      tripped: true,
      avgBps: 7.5,
      samples: 20,
    });
    mockedHaltForDivergence.mockRejectedValue(new Error("halt write failed"));
    const adapter = makeAdapter();
    const { supabase, captures } = makePaperPositionsUpdateMock();
    await executeLiveEntry(
      defaultEntryArgs({
        supabase,
        lots: 0.1,
        ctx: { adapter, conn: makeConn() },
        divergenceRule: { max_avg_bps: 5, window_trades: 20 },
      })
    );
    expect(adapter.placeMarketOrder).toHaveBeenCalledOnce();
    expect(captures.payloads[0].broker_error).toBeNull();
    expect(captures.payloads[0]).not.toHaveProperty("status");
    expect(mockedLogger.warn).toHaveBeenCalledOnce();
  });
});

// ======================================================================
// executeLiveEntry — broker reject rollback (2026-05-18 zombie-position bug)
// ======================================================================

describe("executeLiveEntry — broker reject rollback", () => {
  it("broker throws Error → paper closed with broker_rejected + voided:true + broker_error msg", async () => {
    const adapter = makeAdapter({
      placeMarketOrder: vi.fn().mockRejectedValue(new Error("MARKET_CLOSED")),
    });
    const { supabase, captures } = makePaperPositionsUpdateMock();
    await executeLiveEntry(
      defaultEntryArgs({ supabase, lots: 0.1, ctx: { adapter, conn: makeConn() } })
    );
    expect(captures.payloads[0]).toMatchObject({
      status: "closed",
      exit_reason: "broker_rejected",
      realized_pnl: 0,
      broker_error: "MARKET_CLOSED",
    });
    expect(captures.payloads[0].closed_at).toEqual(expect.any(String));
    expect(mockedLogActivity.mock.calls[0][2]).toMatchObject({
      event_type: "live_order_failed",
      details: { error: "MARKET_CLOSED", voided: true },
    });
  });

  it("non-Error throw → 'Live order failed' default message", async () => {
    const adapter = makeAdapter({
      placeMarketOrder: vi.fn().mockRejectedValue("raw string thrown"),
    });
    const { supabase, captures } = makePaperPositionsUpdateMock();
    await executeLiveEntry(
      defaultEntryArgs({ supabase, lots: 0.1, ctx: { adapter, conn: makeConn() } })
    );
    expect(captures.payloads[0].broker_error).toBe("Live order failed");
  });
});

// ======================================================================
// executeLiveExit
// ======================================================================

describe("executeLiveExit", () => {
  it("brokerPositionId=null → no-op early return (paper never had broker counterpart)", async () => {
    const adapter = makeAdapter();
    const { supabase, captures } = makePaperPositionsUpdateMock();
    await executeLiveExit(
      defaultExitArgs({
        supabase,
        brokerPositionId: null,
        ctx: { adapter, conn: makeConn() },
      })
    );
    expect(adapter.closePosition).not.toHaveBeenCalled();
    expect(captures.payloads).toEqual([]);
    expect(mockedLogActivity).not.toHaveBeenCalled();
  });

  it("closePosition success + dealResult → realized_pnl + broker_close_price from deal + synced_at", async () => {
    const adapter = makeAdapter({
      closePosition: vi.fn().mockResolvedValue({ orderId: "close-1" }),
      fetchClosedDealForPosition: vi
        .fn()
        .mockResolvedValue({ price: 3015.75, realizedPnl: 175.5 }),
    });
    const { supabase, captures } = makePaperPositionsUpdateMock();
    await executeLiveExit(
      defaultExitArgs({ supabase, ctx: { adapter, conn: makeConn() } })
    );
    expect(captures.payloads[0]).toMatchObject({
      broker_close_id: "close-1",
      broker_error: null,
      broker_close_price: 3015.75, // from deal, NOT closePrice arg
      realized_pnl: 175.5,
    });
    expect(captures.payloads[0].broker_realized_synced_at).toEqual(expect.any(String));
  });

  it("dealResult=null → provisional broker_close_price = args.closePrice (deferred reconciliation)", async () => {
    const adapter = makeAdapter({
      fetchClosedDealForPosition: vi.fn().mockResolvedValue(null), // deal lags <60s on MetaApi
    });
    const { supabase, captures } = makePaperPositionsUpdateMock();
    await executeLiveExit(
      defaultExitArgs({
        supabase,
        closePrice: 3010,
        ctx: { adapter, conn: makeConn() },
      })
    );
    expect(captures.payloads[0]).toMatchObject({
      broker_close_id: "close-ord-1",
      broker_error: null,
      broker_close_price: 3010, // provisional from args
    });
    expect(captures.payloads[0]).not.toHaveProperty("realized_pnl");
    expect(captures.payloads[0]).not.toHaveProperty("broker_realized_synced_at");
  });

  it("adapter without fetchClosedDealForPosition → provisional close (no realized_pnl)", async () => {
    const adapter = makeAdapter({ fetchClosedDealForPosition: undefined });
    const { supabase, captures } = makePaperPositionsUpdateMock();
    await executeLiveExit(
      defaultExitArgs({
        supabase,
        closePrice: 3012,
        ctx: { adapter, conn: makeConn() },
      })
    );
    expect(captures.payloads[0].broker_close_price).toBe(3012);
    expect(captures.payloads[0]).not.toHaveProperty("realized_pnl");
  });

  it("logActivity 'live_order_closed' carries the 5 audit-detail fields", async () => {
    const adapter = makeAdapter({
      closePosition: vi.fn().mockResolvedValue({ orderId: "close-1" }),
      fetchClosedDealForPosition: vi
        .fn()
        .mockResolvedValue({ price: 3015.75, realizedPnl: 175.5 }),
    });
    await executeLiveExit(
      defaultExitArgs({
        brokerPositionId: "bpos-XYZ",
        ctx: { adapter, conn: makeConn() },
      })
    );
    expect(mockedLogActivity.mock.calls[0][2]).toMatchObject({
      event_type: "live_order_closed",
      details: {
        broker_position_id: "bpos-XYZ",
        broker_order_id: "close-1",
        broker_realized_synced: true,
        broker_close_price: 3015.75,
        broker_realized_pnl: 175.5,
      },
    });
  });

  it("error path: closePosition throws → paper UPDATE broker_error only + 'live_close_failed' log", async () => {
    const adapter = makeAdapter({
      closePosition: vi.fn().mockRejectedValue(new Error("position not found")),
    });
    const { supabase, captures } = makePaperPositionsUpdateMock();
    await executeLiveExit(
      defaultExitArgs({ supabase, ctx: { adapter, conn: makeConn() } })
    );
    expect(captures.payloads[0]).toEqual({ broker_error: "position not found" });
    expect(mockedLogActivity.mock.calls[0][2]).toMatchObject({
      event_type: "live_close_failed",
      details: { error: "position not found" },
    });
  });

  it("error path: non-Error throw → 'Live close failed' default message", async () => {
    const adapter = makeAdapter({
      closePosition: vi.fn().mockRejectedValue({ rawObject: true }),
    });
    const { supabase, captures } = makePaperPositionsUpdateMock();
    await executeLiveExit(
      defaultExitArgs({ supabase, ctx: { adapter, conn: makeConn() } })
    );
    expect(captures.payloads[0].broker_error).toBe("Live close failed");
  });
});
