/**
 * Unit tests for the scan engine top-level orchestrator (CB.T1.7 pass 3,
 * 2026-06-22 EVE LATE). `scanAlgorithm` wires together:
 *   - watchlist filter (auto_paused skip)
 *   - DLL halt (hard + soft warn)
 *   - load positions
 *   - batch live quotes (with safe fallback)
 *   - broker context resolution
 *   - DXY fetch (conditional)
 *   - intermarket fetch (conditional)
 *   - per-ticker processing via processTicker
 *   - scan_started + scan_completed events
 *   - post-close analytics (pair-quality + drift)
 *   - last_scanned_at write-back
 *
 * Failure mode = silent skip of all gates/positions on a tick = the
 * highest-leverage regression in the entire scan path. Lock the contract.
 *
 * Coverage (20 tests):
 *
 *  Empty-watchlist short-circuits (2):
 *   - Empty watchlist → returns 0-counter result, NO scan_started log
 *   - All tickers auto_paused → same outcome
 *
 *  Halt gating (3):
 *   - maybeHaltOnDailyLoss returns true → bails BEFORE processTicker, NO scan_completed
 *   - maybeWarnOnDailyLoss called even when halt didn't trip
 *   - scan_started + scan_completed both logged on happy path
 *
 *  Batch quotes safe fallback (1):
 *   - fetchBatchQuotes throws → falls back to empty Map (no exception)
 *
 *  DXY conditional fetch (4):
 *   - rules.dxy_filter.enabled → fetches EUR/USD 1h bars
 *   - rules.llm_trader.enabled → fetches EUR/USD 1h bars
 *   - Neither → returns null (NO fetch)
 *   - DXY cache hit → uses cached, NO network fetch
 *
 *  Intermarket conditional fetch (2):
 *   - llm_trader enabled + commodity → fetches silver + yield10y + vix in parallel
 *   - llm_trader enabled but NOT commodity → returns null (no fetch)
 *
 *  Per-ticker processing (1):
 *   - processTicker called once per non-paused ticker
 *
 *  Post-close analytics (4):
 *   - positions_closed > 0 → runPostCloseAnalytics called
 *   - positions_closed = 0 → NOT called (saves DB round-trips on quiet ticks)
 *   - Pair-quality auto-pause → logActivity for each pruned (except already_paused)
 *   - Drift halt severity → executeDriftHalt called + activity log
 *
 *  Side-effect tail (3):
 *   - last_scanned_at update on algorithms after scan_completed
 *   - Drift severity=warn → logActivity but NO executeDriftHalt
 *   - Drift severity=none → NO logActivity, NO executeDriftHalt
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { timeframeToInterval } from "@/lib/market-data/interval";
import { getCachedPrices } from "@/lib/market-data/price-cache";
import { fetchDailyPrices } from "@/lib/market-data/prices";
import { fetchBatchQuotes } from "@/lib/market-data/twelve-data";
import type { PriceBar } from "@/lib/market-data/types";
import type { AlgorithmRules } from "@/types/algorithm";
import { maybeHaltOnDailyLoss, maybeWarnOnDailyLoss } from "./daily-halt";
import { detectDrift, executeDriftHalt } from "./drift-detector";
import { scanAlgorithm } from "./engine";
import { processTicker } from "./engine-process-ticker";
import { logActivity } from "./helpers";
import { resolveBrokerContext } from "./live-execution";
import { evaluateAndPrune } from "./pair-quality";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/market-data/interval", () => ({
  timeframeToInterval: vi.fn().mockReturnValue("4h"),
}));
vi.mock("@/lib/market-data/price-cache", () => ({
  getCachedPrices: vi.fn(),
  savePricesToCache: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/market-data/prices", () => ({ fetchDailyPrices: vi.fn() }));
vi.mock("@/lib/market-data/twelve-data", () => ({ fetchBatchQuotes: vi.fn() }));
vi.mock("./daily-halt", () => ({
  maybeHaltOnDailyLoss: vi.fn(),
  maybeWarnOnDailyLoss: vi.fn(),
}));
vi.mock("./drift-detector", () => ({
  detectDrift: vi.fn(),
  executeDriftHalt: vi.fn(),
  DEFAULT_DRIFT_CONFIG: { minTrades: 10, lookbackTrades: 25 },
}));
vi.mock("./engine-process-ticker", () => ({ processTicker: vi.fn() }));
vi.mock("./engine-position-mgmt", () => ({ manageExistingPosition: vi.fn() }));
vi.mock("./exit-trigger", () => ({ checkExitTrigger: vi.fn() }));
vi.mock("./helpers", () => ({ logActivity: vi.fn() }));
vi.mock("./live-execution", () => ({
  resolveBrokerContext: vi.fn().mockResolvedValue(null),
}));
vi.mock("./pair-quality", () => ({ evaluateAndPrune: vi.fn() }));

const mockedTimeframeInterval = vi.mocked(timeframeToInterval);
const mockedGetCached = vi.mocked(getCachedPrices);
const mockedFetchDaily = vi.mocked(fetchDailyPrices);
const mockedFetchBatch = vi.mocked(fetchBatchQuotes);
const mockedMaybeHalt = vi.mocked(maybeHaltOnDailyLoss);
const mockedMaybeWarn = vi.mocked(maybeWarnOnDailyLoss);
const mockedDetectDrift = vi.mocked(detectDrift);
const mockedExecuteDriftHalt = vi.mocked(executeDriftHalt);
const mockedProcessTicker = vi.mocked(processTicker);
const mockedLogActivity = vi.mocked(logActivity);
const mockedResolveBroker = vi.mocked(resolveBrokerContext);
const mockedEvalPrune = vi.mocked(evaluateAndPrune);

// ---- Supabase mock — only used for loadOpenPositions + last_scanned_at + backtest_results
interface SupabaseMockBag {
  supabase: SupabaseClient;
  fromMock: ReturnType<typeof vi.fn>;
  capturedUpdate: { payload: unknown; eq: [string, unknown] | null } | null;
}

function makeSupabaseMock(opts: { openPositions?: unknown[]; backtestResults?: unknown } = {}): SupabaseMockBag {
  let capturedUpdate: SupabaseMockBag["capturedUpdate"] = null;

  const fromMock = vi.fn().mockImplementation((table: string) => {
    if (table === "paper_positions") {
      // loadOpenPositions chain: select.eq.eq.eq → thenable
      const builder: Record<string, unknown> = {};
      builder.eq = vi.fn().mockImplementation(() => builder);
      builder.then = (onful?: (v: unknown) => unknown, onrej?: (e: unknown) => unknown) =>
        Promise.resolve({ data: opts.openPositions ?? [], error: null }).then(onful, onrej);
      return { select: vi.fn().mockReturnValue(builder) };
    }
    if (table === "algorithms") {
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: { backtest_results: opts.backtestResults ?? null },
              error: null,
            }),
          }),
        }),
        update: vi.fn().mockImplementation((payload: unknown) => {
          const upd = { payload, eq: null as [string, unknown] | null };
          capturedUpdate = upd;
          return {
            eq: vi.fn().mockImplementation((col: string, val: unknown) => {
              upd.eq = [col, val];
              return Promise.resolve({ data: null, error: null });
            }),
          };
        }),
      };
    }
    throw new Error(`Unexpected table: ${table}`);
  });

  const supabaseStub = Object.create(null) as Record<string, unknown>;
  supabaseStub.from = fromMock;
  return {
    supabase: supabaseStub as unknown as SupabaseClient,
    fromMock,
    get capturedUpdate() {
      return capturedUpdate;
    },
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

function makeAlgo(opts: {
  watchlist?: Array<{ ticker: string; name: string; auto_paused?: boolean }>;
  rules?: Partial<AlgorithmRules>;
} = {}) {
  return {
    id: "algo-1",
    name: "Test",
    description: "",
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
      ...opts.rules,
    } as AlgorithmRules,
    capital: 100_000,
    status: "active",
    algorithm_watchlist: opts.watchlist ?? [{ ticker: "XAU/USD", name: "Gold" }],
    live_trading_enabled: false,
    broker_connection_id: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedTimeframeInterval.mockReturnValue("4h");
  mockedFetchBatch.mockResolvedValue(new Map());
  mockedMaybeHalt.mockResolvedValue(false);
  mockedMaybeWarn.mockResolvedValue(false);
  mockedDetectDrift.mockResolvedValue({
    severity: "none",
    reason: "ok",
    recent: { trades: 0, win_rate: 0, net_pnl: 0 },
    baseline: { win_rate: null, total_return: null },
  });
  mockedProcessTicker.mockImplementation(async (_s, _u, _a, _t, _p, result) => {
    result.tickers_scanned++;
  });
  mockedLogActivity.mockResolvedValue(undefined);
  mockedResolveBroker.mockResolvedValue(null);
  mockedEvalPrune.mockResolvedValue([]);
  mockedGetCached.mockResolvedValue(makeBars(30));
  mockedFetchDaily.mockResolvedValue(makeBars(30));
});

// ======================================================================
// Empty-watchlist short-circuits
// ======================================================================

describe("scanAlgorithm — empty watchlist short-circuits", () => {
  it("empty watchlist → returns 0-counter result, NO logs, NO processTicker", async () => {
    const { supabase } = makeSupabaseMock();
    const r = await scanAlgorithm(supabase, "user-1", makeAlgo({ watchlist: [] }));
    expect(r).toEqual({
      algorithm_id: "algo-1",
      algorithm_name: "Test",
      tickers_scanned: 0,
      positions_opened: 0,
      positions_closed: 0,
      positions_updated: 0,
      opened_details: [],
      closed_details: [],
      errors: [],
    });
    expect(mockedLogActivity).not.toHaveBeenCalled();
    expect(mockedProcessTicker).not.toHaveBeenCalled();
  });

  it("all tickers auto_paused → effective list empty → same 0-counter return", async () => {
    const { supabase } = makeSupabaseMock();
    const algo = makeAlgo({
      watchlist: [
        { ticker: "XAU/USD", name: "Gold", auto_paused: true },
        { ticker: "EUR/USD", name: "Euro", auto_paused: true },
      ],
    });
    const r = await scanAlgorithm(supabase, "user-1", algo);
    expect(r.tickers_scanned).toBe(0);
    expect(mockedProcessTicker).not.toHaveBeenCalled();
  });
});

// ======================================================================
// Halt gating
// ======================================================================

describe("scanAlgorithm — halt gating", () => {
  it("maybeHaltOnDailyLoss returns true → bails BEFORE processTicker + NO scan_completed", async () => {
    const { supabase } = makeSupabaseMock();
    mockedMaybeHalt.mockResolvedValue(true);
    const r = await scanAlgorithm(supabase, "user-1", makeAlgo());
    expect(r.tickers_scanned).toBe(0);
    expect(mockedProcessTicker).not.toHaveBeenCalled();
    // scan_started fired BEFORE halt check; scan_completed did NOT
    const eventTypes = mockedLogActivity.mock.calls.map((c) => (c[2] as { event_type: string }).event_type);
    expect(eventTypes).toContain("scan_started");
    expect(eventTypes).not.toContain("scan_completed");
  });

  it("maybeWarnOnDailyLoss called regardless (after halt check, only if halt didn't trip)", async () => {
    const { supabase } = makeSupabaseMock();
    await scanAlgorithm(supabase, "user-1", makeAlgo());
    expect(mockedMaybeHalt).toHaveBeenCalledTimes(1);
    expect(mockedMaybeWarn).toHaveBeenCalledTimes(1);
  });

  it("scan_started + scan_completed both logged on happy path", async () => {
    const { supabase } = makeSupabaseMock();
    await scanAlgorithm(supabase, "user-1", makeAlgo());
    const eventTypes = mockedLogActivity.mock.calls.map((c) => (c[2] as { event_type: string }).event_type);
    expect(eventTypes).toContain("scan_started");
    expect(eventTypes).toContain("scan_completed");
  });
});

// ======================================================================
// Batch quotes safe fallback
// ======================================================================

describe("scanAlgorithm — fetchBatchQuotes safe fallback", () => {
  it("fetchBatchQuotes throws → falls back to empty Map, scan proceeds", async () => {
    const { supabase } = makeSupabaseMock();
    mockedFetchBatch.mockRejectedValue(new Error("Twelve Data 429"));
    await expect(scanAlgorithm(supabase, "user-1", makeAlgo())).resolves.toBeDefined();
    expect(mockedProcessTicker).toHaveBeenCalled(); // didn't bail
    // liveQuotes arg to processTicker is an empty Map
    const liveQuotesArg = mockedProcessTicker.mock.calls[0][6];
    expect(liveQuotesArg.size).toBe(0);
  });
});

// ======================================================================
// DXY conditional fetch
// ======================================================================

describe("scanAlgorithm — DXY conditional fetch", () => {
  it("dxy_filter.enabled=true → fetches EUR/USD 1h bars (cache or network)", async () => {
    const { supabase } = makeSupabaseMock();
    const dxyBars = makeBars(40);
    mockedGetCached.mockResolvedValueOnce(dxyBars); // first call: DXY
    const algo = makeAlgo({ rules: { dxy_filter: { enabled: true } } as unknown as Partial<AlgorithmRules> });
    await scanAlgorithm(supabase, "user-1", algo);
    expect(mockedGetCached).toHaveBeenCalledWith("EUR/USD", "full", "1h");
    // Direct call-args inspection (expect.anything() doesn't match null,
    // and brokerCtx + intermarket are null in this fixture)
    expect(mockedProcessTicker.mock.calls[0][9]).toEqual(dxyBars);
  });

  it("llm_trader.enabled=true → also fetches EUR/USD bars (same path)", async () => {
    const { supabase } = makeSupabaseMock();
    const dxyBars = makeBars(40);
    mockedGetCached.mockResolvedValueOnce(dxyBars);
    const algo = makeAlgo({ rules: { llm_trader: { enabled: true } } as unknown as Partial<AlgorithmRules> });
    await scanAlgorithm(supabase, "user-1", algo);
    expect(mockedGetCached).toHaveBeenCalledWith("EUR/USD", "full", "1h");
  });

  it("neither filter enabled → DXY NOT fetched, dxyBars=null threaded to processTicker", async () => {
    const { supabase } = makeSupabaseMock();
    await scanAlgorithm(supabase, "user-1", makeAlgo());
    // DXY-specific call to getCachedPrices NOT made
    expect(mockedGetCached.mock.calls.find((c) => c[0] === "EUR/USD")).toBeUndefined();
    // dxyBars arg (position 9) is null
    expect(mockedProcessTicker.mock.calls[0][9]).toBeNull();
  });

  it("DXY cache miss + fetch throws → dxyBars=null (caught, doesn't bubble)", async () => {
    const { supabase } = makeSupabaseMock();
    mockedGetCached.mockResolvedValueOnce(null); // first call: DXY → miss
    mockedFetchDaily.mockRejectedValueOnce(new Error("network"));
    const algo = makeAlgo({ rules: { dxy_filter: { enabled: true } } as unknown as Partial<AlgorithmRules> });
    await expect(scanAlgorithm(supabase, "user-1", algo)).resolves.toBeDefined();
    expect(mockedProcessTicker.mock.calls[0][9]).toBeNull(); // fell back to null
  });
});

// ======================================================================
// Intermarket conditional fetch
// ======================================================================

describe("scanAlgorithm — intermarket conditional fetch", () => {
  it("llm_trader + commodity → fetches silver/yield10y/vix in parallel", async () => {
    const { supabase } = makeSupabaseMock();
    const silverBars = makeBars(30);
    const yieldBars = makeBars(30);
    const vixBars = makeBars(30);
    // The first getCached call goes to DXY (EUR/USD); then silver/yield/vix
    mockedGetCached.mockImplementation(async (ticker: string) => {
      if (ticker === "EUR/USD") return makeBars(40);
      if (ticker === "XAG/USD") return silverBars;
      if (ticker === "^TNX") return yieldBars;
      if (ticker === "^VIX") return vixBars;
      return null;
    });
    const algo = makeAlgo({ rules: { llm_trader: { enabled: true }, asset_class: "commodity" } as unknown as Partial<AlgorithmRules> });
    await scanAlgorithm(supabase, "user-1", algo);
    // All three intermarket tickers cached-fetched
    const cachedTickers = mockedGetCached.mock.calls.map((c) => c[0]);
    expect(cachedTickers).toContain("XAG/USD");
    expect(cachedTickers).toContain("^TNX");
    expect(cachedTickers).toContain("^VIX");
    // intermarket arg (position 10) populated
    const intermarketArg = mockedProcessTicker.mock.calls[0][10];
    expect(intermarketArg).toEqual({ silver: silverBars, yield10y: yieldBars, vix: vixBars });
  });

  it("llm_trader enabled but NOT commodity → intermarket=null", async () => {
    const { supabase } = makeSupabaseMock();
    const algo = makeAlgo({ rules: { llm_trader: { enabled: true }, asset_class: "forex" } as unknown as Partial<AlgorithmRules> });
    await scanAlgorithm(supabase, "user-1", algo);
    expect(mockedProcessTicker.mock.calls[0][10]).toBeNull();
    // XAG/USD NOT fetched
    expect(mockedGetCached.mock.calls.find((c) => c[0] === "XAG/USD")).toBeUndefined();
  });
});

// ======================================================================
// Per-ticker processing
// ======================================================================

describe("scanAlgorithm — per-ticker processing", () => {
  it("processTicker called once per non-paused ticker (3 non-paused, 1 paused → 3 calls)", async () => {
    const { supabase } = makeSupabaseMock();
    const algo = makeAlgo({
      watchlist: [
        { ticker: "XAU/USD", name: "Gold" },
        { ticker: "EUR/USD", name: "Euro" },
        { ticker: "GBP/USD", name: "Pound", auto_paused: true },
        { ticker: "USD/JPY", name: "Yen" },
      ],
    });
    await scanAlgorithm(supabase, "user-1", algo);
    expect(mockedProcessTicker).toHaveBeenCalledTimes(3);
    const tickersCalled = mockedProcessTicker.mock.calls.map((c) => c[3]);
    expect(tickersCalled).toEqual(["XAU/USD", "EUR/USD", "USD/JPY"]);
  });
});

// ======================================================================
// Post-close analytics
// ======================================================================

describe("scanAlgorithm — post-close analytics gating", () => {
  it("positions_closed > 0 → runPostCloseAnalytics fires (evaluateAndPrune + detectDrift)", async () => {
    const { supabase } = makeSupabaseMock();
    mockedProcessTicker.mockImplementation(async (_s, _u, _a, _t, _p, result) => {
      result.tickers_scanned++;
      result.positions_closed++;
    });
    await scanAlgorithm(supabase, "user-1", makeAlgo());
    expect(mockedEvalPrune).toHaveBeenCalledWith(expect.anything(), "algo-1");
    expect(mockedDetectDrift).toHaveBeenCalled();
  });

  it("positions_closed = 0 → runPostCloseAnalytics SKIPPED (no DB round-trip on quiet ticks)", async () => {
    const { supabase } = makeSupabaseMock();
    await scanAlgorithm(supabase, "user-1", makeAlgo());
    expect(mockedEvalPrune).not.toHaveBeenCalled();
    expect(mockedDetectDrift).not.toHaveBeenCalled();
  });

  it("pair-quality auto-pause → logActivity for each pruned (except already_paused)", async () => {
    const { supabase } = makeSupabaseMock();
    mockedProcessTicker.mockImplementation(async (_s, _u, _a, _t, _p, result) => {
      result.tickers_scanned++;
      result.positions_closed++;
    });
    mockedEvalPrune.mockResolvedValue([
      { ticker: "XAU/USD", pruned: true, reason: "low_winrate", stats: { wr: 0.1 } },
      { ticker: "EUR/USD", pruned: true, reason: "already_paused", stats: {} }, // skipped
      { ticker: "GBP/USD", pruned: false, reason: "ok", stats: { wr: 0.6 } }, // not pruned
    ] as Array<{ ticker: string; pruned: boolean; reason: string; stats: Record<string, unknown> }>);
    await scanAlgorithm(supabase, "user-1", makeAlgo());
    const autoPauseLogs = mockedLogActivity.mock.calls.filter(
      (c) => (c[2] as { event_type: string }).event_type === "pair_auto_paused"
    );
    expect(autoPauseLogs).toHaveLength(1); // only the low_winrate one
    expect((autoPauseLogs[0][2] as { ticker: string }).ticker).toBe("XAU/USD");
  });

  it("drift severity=halt → logActivity (drift_halt) + executeDriftHalt called", async () => {
    const { supabase } = makeSupabaseMock();
    mockedProcessTicker.mockImplementation(async (_s, _u, _a, _t, _p, result) => {
      result.tickers_scanned++;
      result.positions_closed++;
    });
    mockedDetectDrift.mockResolvedValue({
      severity: "halt",
      reason: "Severe WR drift",
      recent: { trades: 20, win_rate: 30, net_pnl: -200 },
      baseline: { win_rate: 60, total_return: 1000 },
    });
    await scanAlgorithm(supabase, "user-1", makeAlgo());
    expect(mockedExecuteDriftHalt).toHaveBeenCalledTimes(1);
    const driftLogs = mockedLogActivity.mock.calls.filter(
      (c) => (c[2] as { event_type: string }).event_type === "drift_halt"
    );
    expect(driftLogs).toHaveLength(1);
  });
});

// ======================================================================
// Side-effect tail (last_scanned_at + drift warn/none)
// ======================================================================

describe("scanAlgorithm — side-effect tail", () => {
  it("last_scanned_at update on algorithms after scan_completed", async () => {
    const conf = makeSupabaseMock();
    await scanAlgorithm(conf.supabase, "user-1", makeAlgo());
    expect(conf.capturedUpdate?.payload).toMatchObject({ last_scanned_at: expect.any(String) });
    expect(conf.capturedUpdate?.eq).toEqual(["id", "algo-1"]);
  });

  it("drift severity=warn → logActivity (drift_warn) but NO executeDriftHalt", async () => {
    const { supabase } = makeSupabaseMock();
    mockedProcessTicker.mockImplementation(async (_s, _u, _a, _t, _p, result) => {
      result.tickers_scanned++;
      result.positions_closed++;
    });
    mockedDetectDrift.mockResolvedValue({
      severity: "warn",
      reason: "WR drift",
      recent: { trades: 20, win_rate: 45, net_pnl: 100 },
      baseline: { win_rate: 60, total_return: 1000 },
    });
    await scanAlgorithm(supabase, "user-1", makeAlgo());
    expect(mockedExecuteDriftHalt).not.toHaveBeenCalled();
    const driftLogs = mockedLogActivity.mock.calls.filter(
      (c) => (c[2] as { event_type: string }).event_type === "drift_warn"
    );
    expect(driftLogs).toHaveLength(1);
  });

  it("drift severity=none → NO logActivity for drift + NO executeDriftHalt", async () => {
    const { supabase } = makeSupabaseMock();
    mockedProcessTicker.mockImplementation(async (_s, _u, _a, _t, _p, result) => {
      result.tickers_scanned++;
      result.positions_closed++;
    });
    // default mockedDetectDrift returns severity:"none"
    await scanAlgorithm(supabase, "user-1", makeAlgo());
    expect(mockedExecuteDriftHalt).not.toHaveBeenCalled();
    const driftLogs = mockedLogActivity.mock.calls.filter((c) => {
      const ev = (c[2] as { event_type: string }).event_type;
      return ev === "drift_halt" || ev === "drift_warn";
    });
    expect(driftLogs).toHaveLength(0);
  });
});
