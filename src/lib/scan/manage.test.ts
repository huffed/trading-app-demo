/**
 * Unit tests for manage.ts (CB.T1.8, 2026-06-22 NIGHT).
 *
 * Manage-cron entry point — runs every 5 min. Walks every open paper
 * position across active algorithms and runs the exit-trigger check
 * with a fresh live quote. Failure mode = positions never get SL/TP
 * checks during the 15-min scan window gap.
 *
 * Two public surfaces:
 *   1. manageActiveAlgorithms — top-level cron entry
 *   2. reconcileMissingBrokerPosition — re-export from broker-position-sync
 *      (not tested here; tested in broker-position-sync.test.ts)
 *
 * Coverage (18 tests):
 *
 *  Top-level data load (3):
 *   - Empty positions → returns [], NO algo processing
 *   - DB error → returns [], logger.error called
 *   - Successful load → group by algorithm id, one ManageResult per algo
 *
 *  Per-algo grouping (2):
 *   - Same algo + multiple positions on multiple tickers → single ManageResult
 *   - Different algos → multiple ManageResults
 *
 *  manageAlgorithm (per-algo internals) (6):
 *   - positions_inspected = positions.length
 *   - fetchBatchQuotes throws → empty Map fallback (doesn't bubble)
 *   - syncBrokerUnrealizedPnl ALWAYS called
 *   - reconcileBrokerRealizedPnl ONLY when brokerCtx present
 *   - loadBars returns null (< 10 prices) → error pushed for ticker, manage SKIPPED
 *   - loadBars throws → caught, error pushed
 *
 *  Daily bars conditional (1):
 *   - interval='1day' → loadDailyBars returns null (no fetch)
 *
 *  Per-position dispatch (2):
 *   - manageExistingPosition called per position on the matching ticker
 *   - manage counters (closed/updated/closeEvent) thread into ManageResult
 *
 *  Tail best-effort tasks (4):
 *   - reconcileOrphanBrokerRealized always called after manageAlgorithm passes
 *   - reconcileOrphanBrokerRealized throw → logger.warn, doesn't bubble
 *   - backfillClosedTradeOutcomes always called after orphan reconcile
 *   - backfillClosedTradeOutcomes throw → logger.warn, doesn't bubble
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "@/lib/logger";
import { timeframeToInterval } from "@/lib/market-data/interval";
import { getCachedPrices } from "@/lib/market-data/price-cache";
import { fetchDailyPrices, getFreshPricesForScan } from "@/lib/market-data/prices";
import { fetchBatchQuotes } from "@/lib/market-data/twelve-data";
import type { PriceBar } from "@/lib/market-data/types";
import type { PaperPosition } from "@/types/position";
import {
  reconcileMissingBrokerPosition,
  syncBrokerUnrealizedPnl,
} from "./broker-position-sync";
import {
  reconcileBrokerRealizedPnl,
  reconcileOrphanBrokerRealized,
} from "./broker-truth-sync";
import { manageExistingPosition } from "./engine";
import { resolveBrokerContext } from "./live-execution";
import { backfillClosedTradeOutcomes } from "./llm-trader-audit";
import { manageActiveAlgorithms } from "./manage";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/market-data/interval", () => ({
  timeframeToInterval: vi.fn().mockReturnValue("4h"),
}));
vi.mock("@/lib/market-data/price-cache", () => ({
  getCachedPrices: vi.fn(),
  savePricesToCache: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/market-data/prices", () => ({
  fetchDailyPrices: vi.fn(),
  getFreshPricesForScan: vi.fn(),
}));
vi.mock("@/lib/market-data/twelve-data", () => ({ fetchBatchQuotes: vi.fn() }));
vi.mock("./broker-position-sync", () => ({
  reconcileMissingBrokerPosition: vi.fn(),
  syncBrokerUnrealizedPnl: vi.fn(),
}));
vi.mock("./broker-truth-sync", () => ({
  reconcileBrokerRealizedPnl: vi.fn(),
  reconcileOrphanBrokerRealized: vi.fn(),
}));
vi.mock("./engine", () => ({ manageExistingPosition: vi.fn() }));
vi.mock("./live-execution", () => ({ resolveBrokerContext: vi.fn() }));
vi.mock("./llm-trader-audit", () => ({ backfillClosedTradeOutcomes: vi.fn() }));

const mockedLogger = vi.mocked(logger);
const mockedTimeframeInterval = vi.mocked(timeframeToInterval);
const mockedGetCached = vi.mocked(getCachedPrices);
const mockedFetchDaily = vi.mocked(fetchDailyPrices);
const mockedFetchFresh = vi.mocked(getFreshPricesForScan);
const mockedFetchBatch = vi.mocked(fetchBatchQuotes);
const mockedSyncUnrealized = vi.mocked(syncBrokerUnrealizedPnl);
const mockedReconcileRealized = vi.mocked(reconcileBrokerRealizedPnl);
const mockedReconcileOrphan = vi.mocked(reconcileOrphanBrokerRealized);
const mockedManageExisting = vi.mocked(manageExistingPosition);
const mockedResolveBroker = vi.mocked(resolveBrokerContext);
const mockedBackfillOutcomes = vi.mocked(backfillClosedTradeOutcomes);

// ---- Supabase mock for the manageActiveAlgorithms join query.
// .from("paper_positions").select(...).eq.eq → terminal-thenable
interface SupabaseMockBag {
  supabase: SupabaseClient;
  fromMock: ReturnType<typeof vi.fn>;
}

function makeSupabaseMock(opts: {
  positions?: Array<PaperPosition & { algorithms: unknown }>;
  error?: { message: string } | null;
} = {}): SupabaseMockBag {
  const result = {
    data: opts.positions ?? [],
    error: opts.error ?? null,
  };

  const fromMock = vi.fn().mockImplementation((table: string) => {
    if (table !== "paper_positions") throw new Error(`Unexpected table: ${table}`);
    const builder: Record<string, unknown> = {};
    builder.eq = vi.fn().mockImplementation(() => builder);
    builder.then = (onful?: (v: unknown) => unknown, onrej?: (e: unknown) => unknown) =>
      Promise.resolve(result).then(onful, onrej);
    return { select: vi.fn().mockReturnValue(builder) };
  });

  const supabaseStub = Object.create(null) as Record<string, unknown>;
  supabaseStub.from = fromMock;
  return {
    supabase: supabaseStub as unknown as SupabaseClient,
    fromMock,
  };
}

// ---- Fixtures. -------------------------------------------------------
function makeBars(n: number): PriceBar[] {
  return Array.from({ length: n }, (_, i) => ({
    date: `2026-06-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
    open: 3000 + i,
    high: 3010 + i,
    low: 2990 + i,
    close: 3005 + i,
    volume: 100,
  }));
}

function makePosition(overrides: Partial<PaperPosition> = {}): PaperPosition {
  return {
    id: "pos-1",
    user_id: "user-1",
    algorithm_id: "algo-1",
    ticker: "XAU/USD",
    side: "long",
    entry_price: 3000,
    quantity: 1,
    status: "open",
    opened_at: "2026-06-20T00:00:00Z",
    current_price: 3000,
    unrealized_pnl: 0,
    realized_pnl: null,
    stop_loss_price: 2990,
    take_profit_price: 3030,
    exit_reason: null,
    exit_price: null,
    closed_at: null,
    broker_position_id: null,
    ...overrides,
  } as PaperPosition;
}

function makeAlgo(overrides: Record<string, unknown> = {}) {
  return {
    id: "algo-1",
    user_id: "user-1",
    name: "Test",
    rules: {
      timeframe: "4h",
      asset_class: "commodities",
      side: "long",
      max_positions: 5,
      position_sizing: { type: "risk_per_trade", value: 1 },
      stop_loss: { type: "percentage", value: 1.5 },
      take_profit: { type: "percentage", value: 3 },
      entry_conditions: [],
      exit_conditions: [],
    },
    status: "active",
    live_trading_enabled: false,
    broker_connection_id: null,
    ...overrides,
  };
}

function makeJoinedRow(positionOverrides: Partial<PaperPosition> = {}, algoOverrides: Record<string, unknown> = {}) {
  return {
    ...makePosition(positionOverrides),
    algorithms: makeAlgo(algoOverrides),
  } as PaperPosition & { algorithms: ReturnType<typeof makeAlgo> };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedTimeframeInterval.mockReturnValue("4h");
  mockedFetchBatch.mockResolvedValue(new Map());
  mockedFetchFresh.mockResolvedValue(makeBars(50));
  mockedGetCached.mockResolvedValue(makeBars(30));
  mockedFetchDaily.mockResolvedValue(makeBars(30));
  mockedSyncUnrealized.mockResolvedValue(undefined);
  mockedReconcileRealized.mockResolvedValue(undefined);
  mockedReconcileOrphan.mockResolvedValue(undefined);
  mockedBackfillOutcomes.mockResolvedValue(undefined);
  mockedResolveBroker.mockResolvedValue(null);
  mockedManageExisting.mockResolvedValue({ closed: 0, updated: 1 });
});

// ======================================================================
// Top-level data load
// ======================================================================

describe("manageActiveAlgorithms — top-level data load", () => {
  it("empty positions → returns [], NO algo processing, NO tail tasks", async () => {
    const { supabase } = makeSupabaseMock({ positions: [] });
    const r = await manageActiveAlgorithms(supabase);
    expect(r).toEqual([]);
    expect(mockedManageExisting).not.toHaveBeenCalled();
    expect(mockedResolveBroker).not.toHaveBeenCalled();
    // Tail tasks STILL run on empty (idempotent + best-effort)
    expect(mockedReconcileOrphan).toHaveBeenCalledTimes(1);
    expect(mockedBackfillOutcomes).toHaveBeenCalledTimes(1);
  });

  it("DB error → returns [], logger.error called, NO tail tasks", async () => {
    const { supabase } = makeSupabaseMock({ error: { message: "connection lost" } });
    const r = await manageActiveAlgorithms(supabase);
    expect(r).toEqual([]);
    expect(mockedLogger.error).toHaveBeenCalledWith(
      "manage-positions",
      "Failed to load open positions",
      { message: "connection lost" }
    );
    // Error short-circuits — orphan + backfill NOT called
    expect(mockedReconcileOrphan).not.toHaveBeenCalled();
    expect(mockedBackfillOutcomes).not.toHaveBeenCalled();
  });

  it("successful load with 1 algo × 1 position → 1 ManageResult", async () => {
    const { supabase } = makeSupabaseMock({ positions: [makeJoinedRow()] });
    const r = await manageActiveAlgorithms(supabase);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({
      algorithm_id: "algo-1",
      algorithm_name: "Test",
      positions_inspected: 1,
    });
  });
});

// ======================================================================
// Per-algo grouping
// ======================================================================

describe("manageActiveAlgorithms — per-algo grouping", () => {
  it("same algo + multiple positions on multiple tickers → single ManageResult", async () => {
    const { supabase } = makeSupabaseMock({
      positions: [
        makeJoinedRow({ id: "p1", ticker: "XAU/USD" }),
        makeJoinedRow({ id: "p2", ticker: "EUR/USD" }),
        makeJoinedRow({ id: "p3", ticker: "XAU/USD" }),
      ],
    });
    const r = await manageActiveAlgorithms(supabase);
    expect(r).toHaveLength(1); // single algo → single result
    expect(r[0].positions_inspected).toBe(3);
    // Broker context resolved ONCE per algo (not per position)
    expect(mockedResolveBroker).toHaveBeenCalledTimes(1);
    // Batch quote ONCE per algo for all 2 unique tickers
    expect(mockedFetchBatch).toHaveBeenCalledTimes(1);
    expect(mockedFetchBatch).toHaveBeenCalledWith(expect.arrayContaining(["XAU/USD", "EUR/USD"]));
  });

  it("different algos → multiple ManageResults, separate broker contexts", async () => {
    const { supabase } = makeSupabaseMock({
      positions: [
        makeJoinedRow({ id: "p1" }, { id: "algo-1", name: "A1" }),
        makeJoinedRow({ id: "p2" }, { id: "algo-2", name: "A2" }),
      ],
    });
    const r = await manageActiveAlgorithms(supabase);
    expect(r).toHaveLength(2);
    expect(r.map((x) => x.algorithm_id).sort()).toEqual(["algo-1", "algo-2"]);
    expect(mockedResolveBroker).toHaveBeenCalledTimes(2);
  });
});

// ======================================================================
// manageAlgorithm internals
// ======================================================================

describe("manageActiveAlgorithms — per-algo manageAlgorithm internals", () => {
  it("positions_inspected = positions.length (set at start, never decremented)", async () => {
    const { supabase } = makeSupabaseMock({
      positions: [makeJoinedRow({ id: "p1" }), makeJoinedRow({ id: "p2" })],
    });
    const r = await manageActiveAlgorithms(supabase);
    expect(r[0].positions_inspected).toBe(2);
  });

  it("fetchBatchQuotes throws → empty Map fallback (doesn't bubble), manage proceeds", async () => {
    mockedFetchBatch.mockRejectedValue(new Error("rate limit"));
    const { supabase } = makeSupabaseMock({ positions: [makeJoinedRow()] });
    const r = await manageActiveAlgorithms(supabase);
    expect(r[0].errors).toHaveLength(0); // no error pushed; manage continues
    // manageExistingPosition still called with livePrice=null (Map miss)
    expect(mockedManageExisting).toHaveBeenCalledTimes(1);
    const livePriceArg = mockedManageExisting.mock.calls[0][7];
    expect(livePriceArg).toBeNull();
  });

  it("syncBrokerUnrealizedPnl ALWAYS called (even brokerCtx=null — no-op inside)", async () => {
    const { supabase } = makeSupabaseMock({ positions: [makeJoinedRow()] });
    await manageActiveAlgorithms(supabase);
    expect(mockedSyncUnrealized).toHaveBeenCalledTimes(1);
  });

  it("reconcileBrokerRealizedPnl ONLY when brokerCtx present (skipped on null)", async () => {
    // brokerCtx=null path (default mock)
    const { supabase: s1 } = makeSupabaseMock({ positions: [makeJoinedRow()] });
    await manageActiveAlgorithms(s1);
    expect(mockedReconcileRealized).not.toHaveBeenCalled();

    // brokerCtx populated path
    mockedResolveBroker.mockResolvedValue({ adapter: {}, conn: {} } as unknown as Awaited<ReturnType<typeof resolveBrokerContext>>);
    const { supabase: s2 } = makeSupabaseMock({ positions: [makeJoinedRow()] });
    await manageActiveAlgorithms(s2);
    expect(mockedReconcileRealized).toHaveBeenCalledTimes(1);
    expect(mockedReconcileRealized).toHaveBeenCalledWith(s2, expect.anything(), "algo-1");
  });

  it("loadBars returns null (< 10 prices) → error pushed for ticker, manage SKIPPED for it", async () => {
    mockedFetchFresh.mockResolvedValue(makeBars(5)); // too few
    const { supabase } = makeSupabaseMock({ positions: [makeJoinedRow()] });
    const r = await manageActiveAlgorithms(supabase);
    expect(r[0].errors).toEqual([{ ticker: "XAU/USD", error: "Not enough price data" }]);
    expect(mockedManageExisting).not.toHaveBeenCalled();
    // logger.warn fired inside loadBars (the < 10 path returns null without warn,
    // but the throw path warns — covered in next test)
  });

  it("loadBars throws → loadBars catches, warns, returns null → ticker error pushed", async () => {
    mockedFetchFresh.mockRejectedValue(new Error("Twelve Data 429"));
    const { supabase } = makeSupabaseMock({ positions: [makeJoinedRow()] });
    const r = await manageActiveAlgorithms(supabase);
    // loadBars caught the throw + logged + returned null → ticker error pushed
    expect(r[0].errors).toEqual([{ ticker: "XAU/USD", error: "Not enough price data" }]);
    expect(mockedLogger.warn).toHaveBeenCalledWith(
      "manage",
      expect.stringContaining("loadBars(XAU/USD, 4h) failed"),
      expect.any(Error)
    );
  });
});

// ======================================================================
// Daily bars conditional
// ======================================================================

describe("manageActiveAlgorithms — loadDailyBars conditional", () => {
  it("interval='1day' → loadDailyBars returns null (NO cache + NO fetch)", async () => {
    mockedTimeframeInterval.mockReturnValue("1day");
    const { supabase } = makeSupabaseMock({ positions: [makeJoinedRow()] });
    await manageActiveAlgorithms(supabase);
    expect(mockedGetCached).not.toHaveBeenCalled();
    expect(mockedFetchDaily).not.toHaveBeenCalled();
    // dailyBars arg (position 9) is null
    expect(mockedManageExisting.mock.calls[0][9]).toBeNull();
  });
});

// ======================================================================
// Per-position dispatch
// ======================================================================

describe("manageActiveAlgorithms — per-position dispatch", () => {
  it("manageExistingPosition called per position on the matching ticker", async () => {
    const { supabase } = makeSupabaseMock({
      positions: [
        makeJoinedRow({ id: "p1", ticker: "XAU/USD" }),
        makeJoinedRow({ id: "p2", ticker: "EUR/USD" }),
        makeJoinedRow({ id: "p3", ticker: "XAU/USD" }),
      ],
    });
    await manageActiveAlgorithms(supabase);
    expect(mockedManageExisting).toHaveBeenCalledTimes(3);
    const dispatchedTickers = mockedManageExisting.mock.calls.map((c) => c[3]);
    // XAU/USD processed before EUR/USD due to Set ordering — tickers from Set.iter()
    expect(new Set(dispatchedTickers)).toEqual(new Set(["XAU/USD", "EUR/USD"]));
  });

  it("manage counters (closed/updated/closeEvent) thread into ManageResult", async () => {
    mockedManageExisting.mockResolvedValueOnce({
      closed: 1,
      updated: 0,
      closeEvent: { ticker: "XAU/USD", reason: "take_profit", pnl: 50, price: 3030 },
    });
    const { supabase } = makeSupabaseMock({ positions: [makeJoinedRow()] });
    const r = await manageActiveAlgorithms(supabase);
    expect(r[0].positions_closed).toBe(1);
    expect(r[0].positions_updated).toBe(0);
    expect(r[0].closed_details).toEqual([
      { ticker: "XAU/USD", reason: "take_profit", pnl: 50, price: 3030 },
    ]);
  });
});

// ======================================================================
// Tail best-effort tasks
// ======================================================================

describe("manageActiveAlgorithms — tail best-effort tasks", () => {
  it("reconcileOrphanBrokerRealized called with algoIds set after main loop", async () => {
    const { supabase } = makeSupabaseMock({
      positions: [
        makeJoinedRow({ id: "p1" }, { id: "algo-1" }),
        makeJoinedRow({ id: "p2" }, { id: "algo-2" }),
      ],
    });
    await manageActiveAlgorithms(supabase);
    expect(mockedReconcileOrphan).toHaveBeenCalledTimes(1);
    const algoIdSetArg = mockedReconcileOrphan.mock.calls[0][1];
    expect(algoIdSetArg).toEqual(new Set(["algo-1", "algo-2"]));
  });

  it("reconcileOrphanBrokerRealized throw → logger.warn called, doesn't bubble", async () => {
    mockedReconcileOrphan.mockRejectedValue(new Error("broker unreachable"));
    const { supabase } = makeSupabaseMock({ positions: [makeJoinedRow()] });
    await expect(manageActiveAlgorithms(supabase)).resolves.toBeDefined();
    expect(mockedLogger.warn).toHaveBeenCalledWith(
      "manage-positions",
      "broker realized reconciliation failed",
      { error: "broker unreachable" }
    );
    // backfill STILL runs even though orphan threw
    expect(mockedBackfillOutcomes).toHaveBeenCalled();
  });

  it("backfillClosedTradeOutcomes always called AFTER orphan reconcile", async () => {
    const callOrder: string[] = [];
    mockedReconcileOrphan.mockImplementation(async () => {
      callOrder.push("orphan");
    });
    mockedBackfillOutcomes.mockImplementation(async () => {
      callOrder.push("backfill");
    });
    const { supabase } = makeSupabaseMock({ positions: [makeJoinedRow()] });
    await manageActiveAlgorithms(supabase);
    expect(callOrder).toEqual(["orphan", "backfill"]);
  });

  it("backfillClosedTradeOutcomes throw → logger.warn called, doesn't bubble", async () => {
    mockedBackfillOutcomes.mockRejectedValue(new Error("audit table locked"));
    const { supabase } = makeSupabaseMock({ positions: [makeJoinedRow()] });
    await expect(manageActiveAlgorithms(supabase)).resolves.toBeDefined();
    expect(mockedLogger.warn).toHaveBeenCalledWith(
      "manage-positions",
      "trade outcome backfill failed",
      { error: "audit table locked" }
    );
  });
});

// ======================================================================
// Re-export contract (back-compat for scripts/reconcile-broker-close.ts)
// ======================================================================

describe("manage — back-compat re-export", () => {
  it("reconcileMissingBrokerPosition is re-exported from broker-position-sync", async () => {
    const { reconcileMissingBrokerPosition: reExported } = await import("./manage");
    expect(reExported).toBe(reconcileMissingBrokerPosition);
  });
});
