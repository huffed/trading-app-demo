/**
 * Unit tests for the shared entry-gates module (CB.T1 pass 7,
 * 2026-06-22). Seventh test in `src/lib/scan/`. Tests the 3 helpers
 * used by BOTH the deterministic and LLM entry paths:
 *  - checkDirectionConflict (supabase select chain → block/allow verdict)
 *  - checkNewsVeto (calendar query + window-overlap check)
 *  - computeLiveMarketState (multi-source fetch + 4h-frame state read)
 *
 * Coverage:
 *  checkDirectionConflict (5 tests):
 *   - Allows when no sibling positions exist
 *   - Allows on supabase error (defensive — don't block on infra fail)
 *   - Blocks with reason + ids when sibling holds opposite side
 *   - Queries opposite side (long entry → searches for short positions)
 *   - Deduplicates conflicting_algorithm_ids
 *
 *  checkNewsVeto (5 tests):
 *   - Returns vetoed:false when news_veto config is disabled/missing
 *   - Returns vetoed:false when no currencies parseable from ticker
 *   - Fetches calendar with window=max(before, after)*60000ms
 *   - Returns vetoed:true with reason when isWithinVetoWindow returns hit
 *   - Returns vetoed:false when isWithinVetoWindow returns null
 *
 *  computeLiveMarketState (5 tests):
 *   - Returns null when timeframe !== "4h" (non-4h ungated)
 *   - Returns null when computeMarketState4h throws (specialist fail closed)
 *   - Uses cached 1h bars when ≥30 bars available
 *   - Fetches fresh 1h when cache empty or < 30 bars
 *   - Resamples dxyBars to 4h before passing to state computer
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchEconomicCalendar,
  getEventCurrencies,
  isWithinVetoWindow,
} from "@/lib/market-data/economic-calendar";
import { computeMarketState4h } from "@/lib/market-data/market-state";
import { getCachedPrices, savePricesToCache } from "@/lib/market-data/price-cache";
import { fetchDailyPrices } from "@/lib/market-data/prices";
import { resampleTo } from "@/lib/market-data/resample";
import type { AlgorithmRules } from "@/types/algorithm";
import {
  checkDirectionConflict,
  checkNewsVeto,
  computeLiveMarketState,
} from "./entry-gates";
import type { SupabaseClient } from "@supabase/supabase-js";

// ---- Mocks. -----------------------------------------------------------
vi.mock("@/lib/market-data/economic-calendar", () => ({
  fetchEconomicCalendar: vi.fn(),
  getEventCurrencies: vi.fn(),
  isWithinVetoWindow: vi.fn(),
}));
vi.mock("@/lib/market-data/market-state", () => ({
  computeMarketState4h: vi.fn(),
}));
vi.mock("@/lib/market-data/price-cache", () => ({
  getCachedPrices: vi.fn(),
  savePricesToCache: vi.fn(),
}));
vi.mock("@/lib/market-data/prices", () => ({
  fetchDailyPrices: vi.fn(),
}));
vi.mock("@/lib/market-data/resample", () => ({
  resampleTo: vi.fn(),
}));

const mockedFetchEconomicCalendar = vi.mocked(fetchEconomicCalendar);
const mockedGetEventCurrencies = vi.mocked(getEventCurrencies);
const mockedIsWithinVetoWindow = vi.mocked(isWithinVetoWindow);
const mockedComputeMarketState4h = vi.mocked(computeMarketState4h);
const mockedGetCachedPrices = vi.mocked(getCachedPrices);
const mockedSavePricesToCache = vi.mocked(savePricesToCache);
const mockedFetchDailyPrices = vi.mocked(fetchDailyPrices);
const mockedResampleTo = vi.mocked(resampleTo);

// ---- Supabase chain mock for checkDirectionConflict. ------------------
// The select chain is .from(t).select(c).eq(...).eq(...).eq(...).eq(...).neq(...)
// where the FINAL .neq awaits a `{data, error}` promise. Build a chainable
// stub where every method returns `this` until the terminal `.neq(...)`.
function makeSupabaseConflictMock(opts: {
  data?: Array<{ algorithm_id: string }> | null;
  error?: { message: string } | null;
} = {}): {
  supabase: SupabaseClient;
  fromMock: ReturnType<typeof vi.fn>;
  capturedEqCalls: Array<[string, unknown]>;
  capturedNeqCall: [string, unknown] | null;
} {
  const capturedEqCalls: Array<[string, unknown]> = [];
  let capturedNeqCall: [string, unknown] | null = null;
  // Terminal: returns the final {data, error} promise.
  const neqMock = vi.fn().mockImplementation((col: string, val: unknown) => {
    capturedNeqCall = [col, val];
    return Promise.resolve({
      data: opts.data === undefined ? [] : opts.data,
      error: opts.error ?? null,
    });
  });
  // Chainable: .eq returns the same builder (so subsequent .eq/.neq work).
  const builder = {
    eq: vi.fn().mockImplementation((col: string, val: unknown) => {
      capturedEqCalls.push([col, val]);
      return builder;
    }),
    neq: neqMock,
  };
  const selectMock = vi.fn().mockReturnValue(builder);
  const fromMock = vi.fn().mockReturnValue({ select: selectMock });
  const supabaseStub = Object.create(null) as Record<string, unknown>;
  supabaseStub.from = fromMock;
  return {
    supabase: supabaseStub as unknown as SupabaseClient,
    fromMock,
    capturedEqCalls,
    get capturedNeqCall() {
      return capturedNeqCall;
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default mocks: empty calendar, no currencies, no veto hit, ok state
  mockedFetchEconomicCalendar.mockResolvedValue([]);
  mockedGetEventCurrencies.mockReturnValue([]);
  mockedIsWithinVetoWindow.mockReturnValue(null);
  const stateStub = Object.create(null) as ReturnType<typeof computeMarketState4h>;
  mockedComputeMarketState4h.mockReturnValue(stateStub);
  mockedGetCachedPrices.mockResolvedValue(null);
  mockedSavePricesToCache.mockResolvedValue(undefined);
  mockedFetchDailyPrices.mockResolvedValue([]);
  mockedResampleTo.mockReturnValue([]);
});

// ======================================================================
// checkDirectionConflict
// ======================================================================

describe("checkDirectionConflict — supabase select + verdict", () => {
  it("allows when supabase returns no rows (no sibling positions)", async () => {
    const { supabase } = makeSupabaseConflictMock({ data: [] });
    const result = await checkDirectionConflict(supabase, "user-1", "algo-1", "XAU/USD", "long");
    expect(result).toEqual({ block: false });
  });

  it("allows on supabase error (defensive — don't block entries on infra failure)", async () => {
    const { supabase } = makeSupabaseConflictMock({
      data: null,
      error: { message: "connection lost" },
    });
    const result = await checkDirectionConflict(supabase, "user-1", "algo-1", "XAU/USD", "long");
    expect(result).toEqual({ block: false });
  });

  it("blocks with reason + conflicting_algorithm_ids when sibling holds opposite side", async () => {
    const { supabase } = makeSupabaseConflictMock({
      data: [{ algorithm_id: "algo-B" }, { algorithm_id: "algo-C" }],
    });
    const result = await checkDirectionConflict(supabase, "user-1", "algo-1", "XAU/USD", "long");
    expect(result).toEqual({
      block: true,
      reason: "Direction conflict: 2 sibling algo(s) hold opposing short on XAU/USD",
      conflicting_algorithm_ids: ["algo-B", "algo-C"],
    });
  });

  it("queries the OPPOSITE side (long entry → searches for short positions)", async () => {
    const conflict = makeSupabaseConflictMock({ data: [] });
    await checkDirectionConflict(conflict.supabase, "user-1", "algo-1", "XAU/USD", "long");
    // The .eq calls capture (col, val) tuples in order.
    expect(conflict.capturedEqCalls).toEqual([
      ["user_id", "user-1"],
      ["ticker", "XAU/USD"],
      ["status", "open"],
      ["side", "short"], // opposite of "long"
    ]);
    expect(conflict.capturedNeqCall).toEqual(["algorithm_id", "algo-1"]);

    // Same check for short → searches for long
    const conflict2 = makeSupabaseConflictMock({ data: [] });
    await checkDirectionConflict(conflict2.supabase, "user-1", "algo-1", "XAU/USD", "short");
    expect(conflict2.capturedEqCalls[3]).toEqual(["side", "long"]);
  });

  it("deduplicates conflicting_algorithm_ids when same algo holds multiple positions on the ticker", async () => {
    const { supabase } = makeSupabaseConflictMock({
      data: [
        { algorithm_id: "algo-B" },
        { algorithm_id: "algo-B" }, // dup
        { algorithm_id: "algo-C" },
        { algorithm_id: "algo-B" }, // dup
      ],
    });
    const result = await checkDirectionConflict(supabase, "user-1", "algo-1", "XAU/USD", "long");
    expect(result).toMatchObject({
      block: true,
      conflicting_algorithm_ids: ["algo-B", "algo-C"], // de-duped
    });
  });
});

// ======================================================================
// checkNewsVeto
// ======================================================================

function makeRulesWithVeto(opts: {
  enabled?: boolean;
  before?: number;
  after?: number;
  min_impact?: "low" | "medium" | "high";
} = {}): AlgorithmRules {
  if (opts.enabled === false) {
    return { news_veto: { enabled: false } } as unknown as AlgorithmRules;
  }
  return {
    news_veto: {
      enabled: opts.enabled ?? true,
      block_minutes_before: opts.before ?? 30,
      block_minutes_after: opts.after ?? 60,
      min_impact: opts.min_impact ?? "medium",
    },
  } as unknown as AlgorithmRules;
}

describe("checkNewsVeto", () => {
  it("returns vetoed:false when news_veto config is missing/disabled", async () => {
    // Missing entirely — Object.create(null) sidesteps the object-literal
    // assertion rule (same pattern as the rest of CB.T1 fixtures).
    const emptyRules = Object.create(null) as AlgorithmRules;
    expect(await checkNewsVeto(emptyRules, "XAU/USD")).toEqual({ vetoed: false });
    // Explicitly disabled
    expect(await checkNewsVeto(makeRulesWithVeto({ enabled: false }), "XAU/USD")).toEqual({
      vetoed: false,
    });
    // No calendar fetch attempted
    expect(mockedFetchEconomicCalendar).not.toHaveBeenCalled();
  });

  it("returns vetoed:false when getEventCurrencies returns empty (ticker has no parseable currencies)", async () => {
    mockedGetEventCurrencies.mockReturnValue([]);
    const result = await checkNewsVeto(makeRulesWithVeto(), "UNKNOWN_TICKER");
    expect(result).toEqual({ vetoed: false });
    // Skip-fast — no calendar fetch when ticker has no currencies
    expect(mockedFetchEconomicCalendar).not.toHaveBeenCalled();
  });

  it("fetches calendar with window=max(before, after)*60000ms around now", async () => {
    mockedGetEventCurrencies.mockReturnValue(["USD"]);
    await checkNewsVeto(makeRulesWithVeto({ before: 30, after: 60 }), "XAU/USD");
    expect(mockedFetchEconomicCalendar).toHaveBeenCalledOnce();
    const [windowStart, windowEnd] = mockedFetchEconomicCalendar.mock.calls[0];
    // Window radius = max(30, 60) = 60 min = 3_600_000 ms
    const radius = windowEnd.getTime() - windowStart.getTime();
    expect(radius).toBe(2 * 60 * 60_000); // 2× 60min = 7,200,000 ms
  });

  it("returns vetoed:true with formatted reason when isWithinVetoWindow returns hit", async () => {
    mockedGetEventCurrencies.mockReturnValue(["USD"]);
    mockedIsWithinVetoWindow.mockReturnValue({
      currency: "USD",
      event: "FOMC Rate Decision",
      impact: "high",
    });
    const result = await checkNewsVeto(makeRulesWithVeto(), "XAU/USD");
    expect(result).toEqual({
      vetoed: true,
      reason: "USD FOMC Rate Decision (high impact)",
    });
  });

  it("returns vetoed:false when isWithinVetoWindow returns null (no overlap)", async () => {
    mockedGetEventCurrencies.mockReturnValue(["USD"]);
    mockedIsWithinVetoWindow.mockReturnValue(null);
    const result = await checkNewsVeto(makeRulesWithVeto(), "XAU/USD");
    expect(result).toEqual({ vetoed: false });
  });
});

// ======================================================================
// computeLiveMarketState
// ======================================================================

const BARS_4H = [
  { date: "2026-06-22T00:00:00Z", open: 3000, high: 3015, low: 2990, close: 3010, volume: 100 },
  { date: "2026-06-22T04:00:00Z", open: 3010, high: 3020, low: 3005, close: 3015, volume: 100 },
];

describe("computeLiveMarketState", () => {
  it("returns null when timeframe !== '4h' (function is 4h-frame only)", async () => {
    for (const tf of ["1h", "30m", "15m", "1day"]) {
      const result = await computeLiveMarketState("XAU/USD", tf, BARS_4H);
      expect(result).toBeNull();
    }
    // No upstream fetches attempted for non-4h timeframes
    expect(mockedGetCachedPrices).not.toHaveBeenCalled();
    expect(mockedFetchDailyPrices).not.toHaveBeenCalled();
  });

  it("returns null when computeMarketState4h throws (specialists fail closed)", async () => {
    mockedGetCachedPrices.mockResolvedValue([]);
    mockedFetchDailyPrices.mockResolvedValue([]);
    mockedComputeMarketState4h.mockImplementation(() => {
      throw new Error("indicator math failure");
    });
    const result = await computeLiveMarketState("XAU/USD", "4h", BARS_4H);
    expect(result).toBeNull();
  });

  it("uses cached 1h bars when cache returns ≥30 bars", async () => {
    const fakeCachedBars = Array.from({ length: 50 }, (_, i) => ({
      date: `2026-06-22T${i.toString().padStart(2, "0")}:00:00Z`,
      open: 3000,
      high: 3010,
      low: 2990,
      close: 3005,
      volume: 100,
    }));
    mockedGetCachedPrices.mockResolvedValue(fakeCachedBars);
    await computeLiveMarketState("XAU/USD", "4h", BARS_4H);
    expect(mockedGetCachedPrices).toHaveBeenCalledWith("XAU/USD", "compact", "1h");
    // Should NOT re-fetch when cache satisfies the >= 30 threshold
    expect(mockedFetchDailyPrices).not.toHaveBeenCalled();
    // Verify the cached bars were passed to the state computer
    expect(mockedComputeMarketState4h).toHaveBeenCalledOnce();
    const [stateInput] = mockedComputeMarketState4h.mock.calls[0];
    expect(stateInput.oneHourBars).toBe(fakeCachedBars);
  });

  it("fetches fresh 1h when cache is empty or has < 30 bars", async () => {
    const sparseCachedBars = Array.from({ length: 10 }, (_, i) => ({
      date: `2026-06-22T${i.toString().padStart(2, "0")}:00:00Z`,
      open: 3000,
      high: 3010,
      low: 2990,
      close: 3005,
      volume: 100,
    }));
    mockedGetCachedPrices.mockResolvedValue(sparseCachedBars);
    const freshBars = Array.from({ length: 100 }, (_, i) => ({
      date: `2026-06-22T${i.toString().padStart(2, "0")}:00:00Z`,
      open: 3000,
      high: 3010,
      low: 2990,
      close: 3005,
      volume: 100,
    }));
    mockedFetchDailyPrices.mockResolvedValue(freshBars);
    await computeLiveMarketState("XAU/USD", "4h", BARS_4H);
    expect(mockedFetchDailyPrices).toHaveBeenCalledWith("XAU/USD", "compact", "1h");
    // Fresh bars are persisted to cache (best-effort, .catch(() => {}))
    expect(mockedSavePricesToCache).toHaveBeenCalledWith(
      "XAU/USD",
      "compact",
      freshBars,
      "1h"
    );
    // State computer receives the fresh bars (not the sparse cached ones)
    const [stateInput] = mockedComputeMarketState4h.mock.calls[0];
    expect(stateInput.oneHourBars).toBe(freshBars);
  });

  it("resamples dxyBars to 4h before passing to state computer (study-parity frame)", async () => {
    mockedGetCachedPrices.mockResolvedValue([]);
    mockedFetchDailyPrices.mockResolvedValue([]);
    const dxyBars = [
      { date: "2026-06-22T00:00:00Z", open: 1.05, high: 1.06, low: 1.04, close: 1.055, volume: 0 },
    ];
    const resampled4h = [
      { date: "2026-06-22T00:00:00Z", open: 1.05, high: 1.06, low: 1.04, close: 1.055, volume: 0 },
    ];
    mockedResampleTo.mockReturnValue(resampled4h);
    await computeLiveMarketState("XAU/USD", "4h", BARS_4H, null, dxyBars);
    expect(mockedResampleTo).toHaveBeenCalledWith(dxyBars, "4h");
    const [stateInput] = mockedComputeMarketState4h.mock.calls[0];
    expect(stateInput.eurusd4h).toBe(resampled4h);
  });

  it("eurusd4h defaults to [] when dxyBars is null/undefined (no resample call)", async () => {
    mockedGetCachedPrices.mockResolvedValue([]);
    mockedFetchDailyPrices.mockResolvedValue([]);
    await computeLiveMarketState("XAU/USD", "4h", BARS_4H, null, null);
    expect(mockedResampleTo).not.toHaveBeenCalled();
    const [stateInput] = mockedComputeMarketState4h.mock.calls[0];
    expect(stateInput.eurusd4h).toEqual([]);
  });
});
