/**
 * Unit tests for engine-process-ticker (CB.T1.7 pass 2, 2026-06-22 EVE LATE).
 *
 * Per-ticker orchestrator: fresh prices → daily bars → manage existing
 * positions for ticker → evaluate entry (always — capped is dry-run for
 * telemetry, not silent drop).
 *
 * Coverage (14 tests):
 *
 *  Price/data short-circuits (3):
 *   - prices.length < 10 → error pushed, tickers_scanned++, no manage/entry
 *   - getFreshPricesForScan throws → error logged via activity_log
 *   - error msg propagated when err is Error vs unknown
 *
 *  Daily-bars fetch (3):
 *   - interval='1day' → loadDailyBarsForScan returns null (no D1 fetch)
 *   - interval='4h' + cached D1 → uses cached
 *   - interval='4h' + no cached + fetch throws → dailyBars=null (doesn't bubble)
 *
 *  Position management dispatch (2):
 *   - manageExistingPosition called ONLY for positions matching ticker
 *   - manage result counters threaded into result (closed/updated/closeEvent)
 *
 *  Entry evaluation (3):
 *   - evaluateEntry called ALWAYS — even when capped (capped passed as reason)
 *   - r.opened increments result.positions_opened
 *   - r.openEvent → pushed to opened_details + placeholder pushed to positions
 *
 *  Capped-reason computation (3):
 *   - stillOpen >= maxPositions → "Capped: X/Y positions open"
 *   - openOnTicker >= maxPerTicker → "Capped: X/Y on TICKER"
 *   - No cap hit → null
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getCachedPrices } from "@/lib/market-data/price-cache";
import { fetchDailyPrices, getFreshPricesForScan } from "@/lib/market-data/prices";
import type { PriceBar } from "@/lib/market-data/types";
import type { AlgorithmRules } from "@/types/algorithm";
import type { PaperPosition } from "@/types/position";
import { manageExistingPosition } from "./engine-position-mgmt";
import { processTicker } from "./engine-process-ticker";
import { evaluateEntry } from "./entry";
import { logActivity } from "./helpers";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/market-data/price-cache", () => ({
  getCachedPrices: vi.fn(),
  savePricesToCache: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/market-data/prices", () => ({
  fetchDailyPrices: vi.fn(),
  getFreshPricesForScan: vi.fn(),
}));
vi.mock("./engine-position-mgmt", () => ({ manageExistingPosition: vi.fn() }));
vi.mock("./entry", () => ({ evaluateEntry: vi.fn() }));
vi.mock("./helpers", () => ({ logActivity: vi.fn() }));

const mockedGetCached = vi.mocked(getCachedPrices);
const mockedFetchDaily = vi.mocked(fetchDailyPrices);
const mockedFetchFresh = vi.mocked(getFreshPricesForScan);
const mockedManage = vi.mocked(manageExistingPosition);
const mockedEntry = vi.mocked(evaluateEntry);
const mockedLogActivity = vi.mocked(logActivity);

// ---- Fixtures. -------------------------------------------------------
function makeBars(n: number, startClose = 3000): PriceBar[] {
  return Array.from({ length: n }, (_, i) => ({
    date: `2026-06-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
    open: startClose + i,
    high: startClose + i + 5,
    low: startClose + i - 5,
    close: startClose + i,
    volume: 100,
  }));
}

function makeAlgo(rules: Partial<AlgorithmRules> = {}) {
  return {
    id: "algo-1",
    name: "Test",
    description: "",
    rules: {
      timeframe: "4h",
      asset_class: "commodities",
      side: "long",
      max_positions: 5,
      max_per_ticker: 1,
      position_sizing: { type: "risk_per_trade", value: 1 },
      stop_loss: { type: "percentage", value: 1.5 },
      take_profit: { type: "percentage", value: 3 },
      entry_conditions: [],
      exit_conditions: [],
      ...rules,
    } as AlgorithmRules,
    capital: 100_000,
    status: "active",
    algorithm_watchlist: [{ ticker: "XAU/USD", name: "Gold" }],
  };
}

function makeResult() {
  return {
    tickers_scanned: 0,
    positions_opened: 0,
    positions_closed: 0,
    positions_updated: 0,
    opened_details: [] as Array<{ ticker: string; reason: string; pnl: number; price: number }>,
    closed_details: [] as Array<{ ticker: string; reason: string; pnl: number; price: number }>,
    errors: [] as Array<{ ticker: string; error: string }>,
  };
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

const supabase = Object.create(null) as Record<string, unknown>;
supabase.from = vi.fn();
const supabaseStub = supabase as unknown as SupabaseClient;

beforeEach(() => {
  vi.clearAllMocks();
  mockedFetchFresh.mockResolvedValue(makeBars(50));
  mockedGetCached.mockResolvedValue(makeBars(30));
  mockedFetchDaily.mockResolvedValue(makeBars(30));
  mockedManage.mockResolvedValue({ closed: 0, updated: 0 });
  mockedEntry.mockResolvedValue({ opened: 0 });
  mockedLogActivity.mockResolvedValue(undefined);
});

// ======================================================================
// Price-data short-circuits
// ======================================================================

describe("processTicker — price/data short-circuits", () => {
  it("prices.length < 10 → error pushed, tickers_scanned++, NO manage/entry", async () => {
    mockedFetchFresh.mockResolvedValue(makeBars(5)); // too few
    const result = makeResult();
    await processTicker(supabaseStub, "user-1", makeAlgo(), "XAU/USD", [], result, new Map(), "4h", null, null, null, false);
    expect(result.errors).toEqual([{ ticker: "XAU/USD", error: "Not enough price data" }]);
    expect(result.tickers_scanned).toBe(1);
    expect(mockedManage).not.toHaveBeenCalled();
    expect(mockedEntry).not.toHaveBeenCalled();
  });

  it("getFreshPricesForScan throws Error → error message captured + activity_log emitted", async () => {
    mockedFetchFresh.mockRejectedValue(new Error("Twelve Data timeout"));
    const result = makeResult();
    await processTicker(supabaseStub, "user-1", makeAlgo(), "XAU/USD", [], result, new Map(), "4h", null, null, null, false);
    expect(result.errors).toEqual([{ ticker: "XAU/USD", error: "Twelve Data timeout" }]);
    expect(mockedLogActivity).toHaveBeenCalledWith(
      supabaseStub,
      "user-1",
      expect.objectContaining({
        event_type: "error",
        ticker: "XAU/USD",
        details: { error: "Twelve Data timeout" },
      })
    );
  });

  it("throw with non-Error value → defaults to 'Unknown error' message", async () => {
    mockedFetchFresh.mockRejectedValue("string-thrown"); // not an Error instance
    const result = makeResult();
    await processTicker(supabaseStub, "user-1", makeAlgo(), "XAU/USD", [], result, new Map(), "4h", null, null, null, false);
    expect(result.errors[0].error).toBe("Unknown error");
  });
});

// ======================================================================
// Daily-bars fetch
// ======================================================================

describe("processTicker — daily-bars fetch", () => {
  it("interval='1day' → loadDailyBarsForScan returns null (NO cache + NO fetch)", async () => {
    await processTicker(supabaseStub, "user-1", makeAlgo(), "XAU/USD", [], makeResult(), new Map(), "1day", null, null, null, false);
    expect(mockedGetCached).not.toHaveBeenCalled();
    expect(mockedFetchDaily).not.toHaveBeenCalled();
    // evaluateEntry called with dailyBars=null
    expect(mockedEntry).toHaveBeenCalledWith(expect.objectContaining({ dailyBars: null }));
  });

  it("interval='4h' + cached D1 present → uses cached (NO network fetch)", async () => {
    const cachedBars = makeBars(40, 2900);
    mockedGetCached.mockResolvedValue(cachedBars);
    await processTicker(supabaseStub, "user-1", makeAlgo(), "XAU/USD", [], makeResult(), new Map(), "4h", null, null, null, false);
    expect(mockedGetCached).toHaveBeenCalledWith("XAU/USD", "full", "1day");
    expect(mockedFetchDaily).not.toHaveBeenCalled();
    expect(mockedEntry).toHaveBeenCalledWith(expect.objectContaining({ dailyBars: cachedBars }));
  });

  it("interval='4h' + no cached + fetchDailyPrices throws → dailyBars=null (doesn't bubble)", async () => {
    mockedGetCached.mockResolvedValue(null);
    mockedFetchDaily.mockRejectedValue(new Error("network"));
    // The throw is caught inside loadDailyBarsForScan, so processTicker proceeds
    const result = makeResult();
    await processTicker(supabaseStub, "user-1", makeAlgo(), "XAU/USD", [], result, new Map(), "4h", null, null, null, false);
    expect(result.errors).toHaveLength(0); // doesn't pollute errors
    expect(mockedEntry).toHaveBeenCalledWith(expect.objectContaining({ dailyBars: null }));
  });
});

// ======================================================================
// Position-management dispatch
// ======================================================================

describe("processTicker — position-management dispatch", () => {
  it("manageExistingPosition called ONLY for positions matching ticker", async () => {
    const positions = [
      makePosition({ ticker: "XAU/USD", id: "p1" }),
      makePosition({ ticker: "EUR/USD", id: "p2" }), // not this ticker
      makePosition({ ticker: "XAU/USD", id: "p3" }),
    ];
    await processTicker(supabaseStub, "user-1", makeAlgo(), "XAU/USD", positions, makeResult(), new Map(), "4h", null, null, null, false);
    expect(mockedManage).toHaveBeenCalledTimes(2); // p1 + p3, not p2
    expect((mockedManage.mock.calls[0][4] as { id: string }).id).toBe("p1");
    expect((mockedManage.mock.calls[1][4] as { id: string }).id).toBe("p3");
  });

  it("manage counters thread into result (closed/updated/closeEvent)", async () => {
    mockedManage.mockResolvedValue({
      closed: 1,
      updated: 0,
      closeEvent: { ticker: "XAU/USD", reason: "take_profit", pnl: 50, price: 3030 },
    });
    const positions = [makePosition()];
    const result = makeResult();
    await processTicker(supabaseStub, "user-1", makeAlgo(), "XAU/USD", positions, result, new Map(), "4h", null, null, null, false);
    expect(result.positions_closed).toBe(1);
    expect(result.closed_details).toEqual([
      { ticker: "XAU/USD", reason: "take_profit", pnl: 50, price: 3030 },
    ]);
  });
});

// ======================================================================
// Entry evaluation
// ======================================================================

describe("processTicker — entry evaluation", () => {
  it("evaluateEntry called ALWAYS — capped passed as cappedReason (dry-run for telemetry)", async () => {
    // 5 positions all open on the algo, maxPositions=5 → capped
    const positions = Array.from({ length: 5 }, (_, i) =>
      makePosition({ id: `p${i}`, ticker: i === 0 ? "XAU/USD" : "EUR/USD" })
    );
    await processTicker(supabaseStub, "user-1", makeAlgo({ max_positions: 5 } as Partial<AlgorithmRules>), "XAU/USD", positions, makeResult(), new Map(), "4h", null, null, null, false);
    expect(mockedEntry).toHaveBeenCalledTimes(1);
    expect((mockedEntry.mock.calls[0][0] as { cappedReason: string | null }).cappedReason).toContain("Capped:");
  });

  it("r.opened increments result.positions_opened", async () => {
    mockedEntry.mockResolvedValue({ opened: 1, openEvent: { ticker: "XAU/USD", reason: "signal_buy", pnl: 0, price: 3055 } });
    const result = makeResult();
    const positions: PaperPosition[] = [];
    await processTicker(supabaseStub, "user-1", makeAlgo(), "XAU/USD", positions, result, new Map(), "4h", null, null, null, false);
    expect(result.positions_opened).toBe(1);
    expect(result.opened_details).toHaveLength(1);
  });

  it("r.openEvent → opened_details pushed AND placeholder appended to positions (caps subsequent tickers)", async () => {
    mockedEntry.mockResolvedValue({ opened: 1, openEvent: { ticker: "XAU/USD", reason: "signal_buy", pnl: 0, price: 3055 } });
    const positions: PaperPosition[] = [];
    await processTicker(supabaseStub, "user-1", makeAlgo(), "XAU/USD", positions, makeResult(), new Map(), "4h", null, null, null, false);
    // placeholder pushed into positions so the NEXT ticker sees the count
    expect(positions).toHaveLength(1);
    expect(positions[0]).toMatchObject({ ticker: "XAU/USD", status: "open" });
  });
});

// ======================================================================
// Capped-reason computation
// ======================================================================

describe("processTicker — cappedReason computation", () => {
  it("stillOpen >= maxPositions → 'Capped: X/Y positions open'", async () => {
    const positions = Array.from({ length: 3 }, (_, i) =>
      makePosition({ id: `p${i}`, ticker: i === 0 ? "XAU/USD" : "EUR/USD" })
    );
    await processTicker(supabaseStub, "user-1", makeAlgo({ max_positions: 3 } as Partial<AlgorithmRules>), "GBP/USD", positions, makeResult(), new Map(), "4h", null, null, null, false);
    expect((mockedEntry.mock.calls[0][0] as { cappedReason: string }).cappedReason).toBe("Capped: 3/3 positions open");
  });

  it("openOnTicker >= maxPerTicker (default 1) → 'Capped: X/Y positions open on TICKER'", async () => {
    const positions = [makePosition({ ticker: "XAU/USD" })];
    await processTicker(supabaseStub, "user-1", makeAlgo({ max_positions: 5, max_per_ticker: 1 } as Partial<AlgorithmRules>), "XAU/USD", positions, makeResult(), new Map(), "4h", null, null, null, false);
    expect((mockedEntry.mock.calls[0][0] as { cappedReason: string }).cappedReason).toBe("Capped: 1/1 positions open on XAU/USD");
  });

  it("no cap hit → cappedReason=null", async () => {
    const positions = [makePosition({ ticker: "EUR/USD" })]; // open on different ticker
    await processTicker(supabaseStub, "user-1", makeAlgo({ max_positions: 5, max_per_ticker: 1 } as Partial<AlgorithmRules>), "XAU/USD", positions, makeResult(), new Map(), "4h", null, null, null, false);
    expect((mockedEntry.mock.calls[0][0] as { cappedReason: string | null }).cappedReason).toBeNull();
  });
});
