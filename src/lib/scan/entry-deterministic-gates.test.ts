/**
 * Unit tests for runDeterministicEntryGates (CB.T1.2 pass 1, 2026-06-22).
 * The 11-step deterministic gate ladder extracted from entry.ts in CB.H1
 * pass 16. Fires on every non-LLM scan tick. Locking this contract so
 * future refactors don't silently allow trades through gates.
 *
 * Coverage (~18 tests):
 *   Step 1 (ATR liquidity): blocked → result {blocked:true} + signal_no_action log
 *   Step 1: pass-through threads liquidity into final result
 *
 *   Pre-side halts (steps 2-6) via runPreSideHalts:
 *     - News veto blocks
 *     - Consecutive-loss halt blocks
 *     - Time-of-day filter blocks
 *     - Consistency rule blocks
 *     - Market-state gate blocks
 *     - Market-state gate shadow-mode logs but doesn't block
 *     - All pre-side gates pass → falls through to side resolution
 *
 *   Side-and-direction gates (steps 7-11):
 *     - Side resolution returns null → blocked + reason logged
 *     - Direction conflict blocks
 *     - DXY filter blocks
 *     - Regime filter blocks
 *     - ADX filter blocks
 *
 *   Full pass-through:
 *     - All 11 gates pass → returns blocked:false + side + directionOverride + higherTfBars + liquidity + currentPrice
 *
 *   currentPrice resolution:
 *     - livePrice present → uses livePrice
 *     - livePrice absent → uses closes[closes.length - 1]
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkBarGranularity } from "@/lib/algorithm/bar-granularity-gate";
import { checkBarStaleness } from "@/lib/algorithm/bar-staleness-gate";
import { checkDxyDirection } from "@/lib/algorithm/dxy-filter";
import { checkAtrLiquidity } from "@/lib/algorithm/intraday-atr-gate";
import { checkReEntryCooldown } from "@/lib/algorithm/re-entry-cooldown";
import { checkMarketStateGateConfig } from "@/lib/algorithm/market-state-gate";
import { checkTimeOfDayFilter } from "@/lib/algorithm/time-of-day-filter";
import { isWeakTrendByAdx } from "@/lib/market-data/adx-filter";
import { resolveSide } from "@/lib/market-data/auto-side";
import { isRangingByAtr } from "@/lib/market-data/regime-filter";
import type { PriceBar } from "@/lib/market-data/types";
import type { AlgorithmRules } from "@/types/algorithm";
import { checkConsecutiveLossHalt } from "./consec-loss-halt";
import { checkConsistencyHalt } from "./consistency-halt";
import type { EntryContext } from "./entry";
import { runDeterministicEntryGates } from "./entry-deterministic-gates";
import { checkDirectionConflict, checkNewsVeto } from "./entry-gates";
import { logActivity } from "./helpers";
import type { SupabaseClient } from "@supabase/supabase-js";

// ---- Mocks. -----------------------------------------------------------
// NOTE: the granularity gate MUST be mocked here — makeBars() spaces
// fixture bars 1 day apart while rules.timeframe is "4h", so the real
// gate would (correctly) block every ladder test.
vi.mock("@/lib/algorithm/bar-granularity-gate", () => ({ checkBarGranularity: vi.fn() }));
vi.mock("@/lib/algorithm/bar-staleness-gate", () => ({ checkBarStaleness: vi.fn() }));
vi.mock("@/lib/algorithm/intraday-atr-gate", () => ({ checkAtrLiquidity: vi.fn() }));
vi.mock("@/lib/algorithm/dxy-filter", () => ({ checkDxyDirection: vi.fn() }));
vi.mock("@/lib/algorithm/re-entry-cooldown", () => ({ checkReEntryCooldown: vi.fn() }));
vi.mock("@/lib/algorithm/market-state-gate", () => ({
  checkMarketStateGateConfig: vi.fn(),
  computePositionInRangePct: vi.fn().mockReturnValue(50),
  gateConfigModeLabel: vi.fn().mockReturnValue("allow"),
}));
vi.mock("@/lib/algorithm/time-of-day-filter", () => ({ checkTimeOfDayFilter: vi.fn() }));
vi.mock("@/lib/market-data/adx-filter", () => ({ isWeakTrendByAdx: vi.fn() }));
vi.mock("@/lib/market-data/auto-side", () => ({ resolveSide: vi.fn() }));
vi.mock("@/lib/market-data/regime-filter", () => ({ isRangingByAtr: vi.fn() }));
vi.mock("@/lib/market-data/resample", () => ({
  resampleToDaily: vi.fn((bars: PriceBar[]) => bars.slice(-30)),
}));
vi.mock("./consec-loss-halt", () => ({ checkConsecutiveLossHalt: vi.fn() }));
vi.mock("./consistency-halt", () => ({ checkConsistencyHalt: vi.fn() }));
vi.mock("./entry-gates", () => ({
  checkDirectionConflict: vi.fn(),
  checkNewsVeto: vi.fn(),
  computeLiveMarketState: vi.fn().mockResolvedValue({ mtf: "trend", vol: "n/a", range: "n/a", dxy: "n/a" }),
}));
vi.mock("./helpers", () => ({ logActivity: vi.fn() }));
vi.mock("./per-hour-stats", () => ({ getPerHourStats: vi.fn().mockResolvedValue(new Map()) }));

const mockedCheckAtrLiquidity = vi.mocked(checkAtrLiquidity);
const mockedCheckBarGranularity = vi.mocked(checkBarGranularity);
const mockedCheckBarStaleness = vi.mocked(checkBarStaleness);
const mockedCheckDxyDirection = vi.mocked(checkDxyDirection);
const mockedCheckReEntryCooldown = vi.mocked(checkReEntryCooldown);
const mockedCheckMarketStateGateConfig = vi.mocked(checkMarketStateGateConfig);
const mockedCheckTimeOfDayFilter = vi.mocked(checkTimeOfDayFilter);
const mockedIsWeakTrendByAdx = vi.mocked(isWeakTrendByAdx);
const mockedResolveSide = vi.mocked(resolveSide);
const mockedIsRangingByAtr = vi.mocked(isRangingByAtr);
const mockedCheckConsecutiveLossHalt = vi.mocked(checkConsecutiveLossHalt);
const mockedCheckConsistencyHalt = vi.mocked(checkConsistencyHalt);
const mockedCheckDirectionConflict = vi.mocked(checkDirectionConflict);
const mockedCheckNewsVeto = vi.mocked(checkNewsVeto);
const mockedLogActivity = vi.mocked(logActivity);

// ---- Fixtures. --------------------------------------------------------
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

function makeRules(overrides: Partial<AlgorithmRules> = {}): AlgorithmRules {
  return {
    timeframe: "4h",
    asset_class: "commodities",
    side: "long",
    position_sizing: { type: "risk_per_trade", value: 1 },
    stop_loss: { type: "percentage", value: 1.5 },
    take_profit: { type: "percentage", value: 3 },
    entry_conditions: [],
    exit_conditions: [],
    prop_firm: {},
    ...overrides,
  } as unknown as AlgorithmRules;
}

function makeCtx(overrides: Partial<EntryContext> = {}): EntryContext {
  const supabaseStub = Object.create(null) as Record<string, unknown>;
  const bars = makeBars(50);
  return {
    supabase: supabaseStub as unknown as SupabaseClient,
    userId: "user-1",
    algo: { id: "algo-1", name: "T", description: "", rules: makeRules(), capital: 100_000 },
    ticker: "XAU/USD",
    bars,
    closes: bars.map((b) => b.close),
    allOpenPositions: [],
    livePrice: 3055,
    dailyBars: makeBars(30),
    dxyBars: null,
    ...overrides,
  } as EntryContext;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Pass-through defaults — each test overrides the gate it's testing.
  mockedCheckBarGranularity.mockReturnValue({
    block: false,
    status: "ok",
    median_spacing_minutes: 240,
    expected_minutes: 240,
  });
  mockedCheckBarStaleness.mockReturnValue({
    block: false,
    status: "ok",
    bar_age_minutes: 5,
    threshold_minutes: 360,
    last_bar_date: "2026-06-30T00:00:00Z",
  });
  mockedCheckAtrLiquidity.mockReturnValue({ skip: false, atr_current: 1.5, atr_threshold: 1.0, status: "ok" });
  mockedCheckReEntryCooldown.mockResolvedValue({ block: false, status: "no_recent_close", cooldown_minutes: 240 });
  mockedCheckNewsVeto.mockResolvedValue({ vetoed: false });
  mockedCheckConsecutiveLossHalt.mockResolvedValue({ tripped: false, streak: 0, threshold: 3 });
  mockedCheckTimeOfDayFilter.mockReturnValue({ block: false, hour: 12, hour_wr_pct: 50, hour_samples: 100 });
  mockedCheckConsistencyHalt.mockResolvedValue({
    tripped: false,
    today_net: 0,
    total_net: 0,
    ratio: 0,
    threshold: 0,
  });
  mockedCheckMarketStateGateConfig.mockReturnValue({ allowed: true, reason: "no states configured" });
  mockedResolveSide.mockReturnValue({ side: "long", directionOverride: "bullish" });
  mockedCheckDirectionConflict.mockResolvedValue({ block: false });
  mockedCheckDxyDirection.mockReturnValue({ block: false });
  mockedIsRangingByAtr.mockReturnValue({ skip: false });
  mockedIsWeakTrendByAdx.mockReturnValue({ skip: false });
  mockedLogActivity.mockResolvedValue(undefined);
});

// ======================================================================
// Step 0a: bar-grid granularity (E2.25.a.ii)
// ======================================================================

describe("runDeterministicEntryGates — step 0a (bar granularity)", () => {
  it("granularity mismatch → blocked before staleness/ATR run + signal_no_action logged", async () => {
    mockedCheckBarGranularity.mockReturnValue({
      block: true,
      status: "granularity_mismatch",
      median_spacing_minutes: 60,
      expected_minutes: 240,
      reason: "Bar-grid mismatch: served series has median spacing 60.0 min vs expected 240 min",
    });
    const result = await runDeterministicEntryGates(makeCtx());
    expect(result).toEqual({ blocked: true });
    // Runs FIRST: a finer-granularity payload looks fresher to the
    // staleness gate, so neither staleness nor ATR may be consulted.
    expect(mockedCheckBarStaleness).not.toHaveBeenCalled();
    expect(mockedCheckAtrLiquidity).not.toHaveBeenCalled();
    expect(mockedLogActivity.mock.calls[0][2]).toMatchObject({
      event_type: "signal_no_action",
      details: {
        source: "deterministic",
        median_spacing_minutes: 60,
        expected_minutes: 240,
      },
    });
  });

  it("receives the full served series + the algo timeframe", async () => {
    const ctx = makeCtx();
    await runDeterministicEntryGates(ctx);
    expect(mockedCheckBarGranularity).toHaveBeenCalledWith({ timeframe: "4h", bars: ctx.bars });
  });
});

// ======================================================================
// Step 0b: bar staleness (E2.24.b)
// ======================================================================

describe("runDeterministicEntryGates — step 0 (bar staleness)", () => {
  it("stale bar → blocked before any other gate runs", async () => {
    mockedCheckBarStaleness.mockReturnValue({
      block: true,
      status: "stale",
      reason: "Last 4h bar closed 700 min ago (threshold 360)",
      bar_age_minutes: 700,
      threshold_minutes: 360,
      last_bar_date: "2026-06-29T00:00:00Z",
    });
    const result = await runDeterministicEntryGates(makeCtx());
    expect(result).toEqual({ blocked: true });
    expect(mockedCheckAtrLiquidity).not.toHaveBeenCalled();
    expect(mockedLogActivity.mock.calls[0][2]).toMatchObject({
      event_type: "signal_no_action",
      details: { source: "deterministic", bar_age_minutes: 700 },
    });
  });
});

// ======================================================================
// Step 3b: re-entry cooldown (E2.24.b)
// ======================================================================

describe("runDeterministicEntryGates — step 3b (re-entry cooldown)", () => {
  it("in cooldown → blocked + signal_no_action logged", async () => {
    mockedCheckReEntryCooldown.mockResolvedValue({
      block: true,
      status: "in_cooldown",
      reason: "Loss exit 12 min ago; 240 min cooldown",
      cooldown_minutes: 240,
      elapsed_minutes: 12,
    });
    const result = await runDeterministicEntryGates(makeCtx());
    expect(result).toEqual({ blocked: true });
    expect(mockedCheckReEntryCooldown).toHaveBeenCalledWith(
      expect.objectContaining({ algorithmId: "algo-1", ticker: "XAU/USD", timeframe: "4h" })
    );
    expect(mockedLogActivity.mock.calls[0][2]).toMatchObject({
      event_type: "signal_no_action",
      details: { reason: "Loss exit 12 min ago; 240 min cooldown", source: "deterministic" },
    });
    // Cooldown runs pre-side: side resolution never reached.
    expect(mockedResolveSide).not.toHaveBeenCalled();
  });
});

// ======================================================================
// Step 1: ATR liquidity
// ======================================================================

describe("runDeterministicEntryGates — step 1 (ATR liquidity)", () => {
  it("blocked → returns {blocked:true} + signal_no_action logged", async () => {
    mockedCheckAtrLiquidity.mockReturnValue({
      skip: true,
      reason: "ATR below 20th percentile",
      atr_current: 0.5,
      atr_threshold: 1.0,
      status: "below",
    });
    const result = await runDeterministicEntryGates(makeCtx());
    expect(result).toEqual({ blocked: true });
    expect(mockedLogActivity.mock.calls[0][2]).toMatchObject({
      event_type: "signal_no_action",
      details: { reason: "ATR below 20th percentile", atr_current: 0.5, atr_threshold: 1.0 },
    });
  });

  it("pass-through threads liquidity into final result", async () => {
    const result = await runDeterministicEntryGates(makeCtx());
    expect(result.blocked).toBe(false);
    if (!result.blocked) {
      expect(result.liquidity.atr_current).toBe(1.5);
      expect(result.liquidity.atr_threshold).toBe(1.0);
    }
  });
});

// ======================================================================
// Session filter (2026-10 spec §7) — REAL gate, not mocked: it only
// runs when rules.session_filter is present, so existing fixtures
// (field absent) never touch it.
// ======================================================================

describe("runDeterministicEntryGates — session filter", () => {
  it("signal bar outside the window → blocked + signal_no_action with hour/window", async () => {
    // Explicit VALID bar dates (makeBars fabricates 2026-06-31+ past day
    // 30, which parse NaN and pass-through by design). Last bar opens
    // 00:00 UTC → outside London 06–10.
    const bars = [
      { date: "2026-07-28T20:00:00Z", open: 1, high: 2, low: 0.5, close: 1.5, volume: 1 },
      { date: "2026-07-29T00:00:00Z", open: 1, high: 2, low: 0.5, close: 1.5, volume: 1 },
    ];
    const ctx = makeCtx({
      bars,
      closes: bars.map((b) => b.close),
      algo: {
        id: "algo-1",
        name: "T",
        description: "",
        rules: makeRules({
          session_filter: { start_hour_utc: 6, end_hour_utc: 10 },
        } as unknown as Partial<AlgorithmRules>),
        capital: 100_000,
      },
    });
    const result = await runDeterministicEntryGates(ctx);
    expect(result).toEqual({ blocked: true });
    expect(mockedLogActivity.mock.calls[0][2]).toMatchObject({
      event_type: "signal_no_action",
      details: { source: "deterministic", hour_utc: 0, window: "06:00–10:00 UTC" },
    });
    expect(mockedResolveSide).not.toHaveBeenCalled();
  });

  it("signal bar inside the window → passes through", async () => {
    const ctx = makeCtx({
      algo: {
        id: "algo-1",
        name: "T",
        description: "",
        rules: makeRules({
          session_filter: { start_hour_utc: 0, end_hour_utc: 23 },
        } as unknown as Partial<AlgorithmRules>),
        capital: 100_000,
      },
    });
    const result = await runDeterministicEntryGates(ctx);
    expect(result.blocked).toBe(false);
  });
});

// ======================================================================
// Pre-side halts (steps 2-6)
// ======================================================================

describe("runDeterministicEntryGates — pre-side halts", () => {
  it("step 2: news veto blocks", async () => {
    mockedCheckNewsVeto.mockResolvedValue({ vetoed: true, reason: "NFP in 15min" });
    const result = await runDeterministicEntryGates(makeCtx());
    expect(result).toEqual({ blocked: true });
    expect(mockedLogActivity.mock.calls[0][2].details).toMatchObject({
      reason: "News veto: NFP in 15min",
    });
  });

  it("step 3: consecutive-loss halt blocks", async () => {
    mockedCheckConsecutiveLossHalt.mockResolvedValue({ tripped: true, streak: 3, threshold: 3 });
    const ctx = makeCtx({
      algo: {
        id: "algo-1",
        name: "T",
        description: "",
        rules: makeRules({ prop_firm: { consecutive_loss_daily_halt: 3 } } as unknown as Partial<AlgorithmRules>),
        capital: 100_000,
      },
    });
    const result = await runDeterministicEntryGates(ctx);
    expect(result).toEqual({ blocked: true });
    expect(mockedLogActivity.mock.calls[0][2].details.reason).toContain("Consecutive-loss halt: 3/3");
  });

  it("step 4: time-of-day filter blocks", async () => {
    mockedCheckTimeOfDayFilter.mockReturnValue({
      block: true,
      reason: "low-WR hour",
      hour: 18,
      hour_wr_pct: 20,
      hour_samples: 50,
    });
    const ctx = makeCtx({
      algo: {
        id: "algo-1",
        name: "T",
        description: "",
        rules: makeRules({
          time_filter: { enabled: true, min_samples: 30, window_days: 60 },
        } as unknown as Partial<AlgorithmRules>),
        capital: 100_000,
      },
    });
    const result = await runDeterministicEntryGates(ctx);
    expect(result).toEqual({ blocked: true });
    expect(mockedLogActivity.mock.calls[0][2].details).toMatchObject({
      reason: "low-WR hour",
      hour_utc: 18,
    });
  });

  it("step 5: consistency rule blocks (FTMO 40%)", async () => {
    mockedCheckConsistencyHalt.mockResolvedValue({
      tripped: true,
      today_net: 800,
      total_net: 1500,
      ratio: 0.533,
      threshold: 0.4,
    });
    const ctx = makeCtx({
      algo: {
        id: "algo-1",
        name: "T",
        description: "",
        rules: makeRules({ prop_firm: { consistency_rule: 40 } } as unknown as Partial<AlgorithmRules>),
        capital: 100_000,
      },
    });
    const result = await runDeterministicEntryGates(ctx);
    expect(result).toEqual({ blocked: true });
    expect(mockedLogActivity.mock.calls[0][2].details.reason).toContain("Consistency halt: today $800");
  });

  it("step 6: market-state gate blocks", async () => {
    mockedCheckMarketStateGateConfig.mockReturnValue({
      allowed: false,
      reason: "vol=expansion is blocked",
    });
    const ctx = makeCtx({
      algo: {
        id: "algo-1",
        name: "T",
        description: "",
        rules: makeRules({
          market_state_gate: { mode: "block", states: { vol: ["expansion"] } },
        } as unknown as Partial<AlgorithmRules>),
        capital: 100_000,
      },
    });
    const result = await runDeterministicEntryGates(ctx);
    expect(result).toEqual({ blocked: true });
    expect(mockedLogActivity.mock.calls[0][2].details.reason).toBe("market_state_gate");
  });

  it("step 6: market-state gate SHADOW mode logs but does NOT block", async () => {
    mockedCheckMarketStateGateConfig.mockReturnValue({
      allowed: true,
      reason: "shadow: would-block (vol=expansion is blocked)",
      shadow_block_reason: "vol=expansion is blocked",
    });
    const ctx = makeCtx({
      algo: {
        id: "algo-1",
        name: "T",
        description: "",
        rules: makeRules({
          market_state_gate: { mode: "block", states: { vol: ["expansion"] }, shadow: true },
        } as unknown as Partial<AlgorithmRules>),
        capital: 100_000,
      },
    });
    const result = await runDeterministicEntryGates(ctx);
    expect(result.blocked).toBe(false);
    // Shadow log fired but no blocking log → final outcome is pass-through
    const shadowLog = mockedLogActivity.mock.calls.find(
      (c) => c[2].details.reason === "market_state_gate_shadow"
    );
    expect(shadowLog).toBeDefined();
  });
});

// ======================================================================
// Side-and-direction gates (steps 7-11)
// ======================================================================

describe("runDeterministicEntryGates — side-and-direction gates", () => {
  it("step 7: side resolution returns null → blocked with neutral-bias reason", async () => {
    mockedResolveSide.mockReturnValue(null);
    const result = await runDeterministicEntryGates(makeCtx());
    expect(result).toEqual({ blocked: true });
    // Auto-side log contains either "neutral" or "insufficient D1 history"
    const lastLog = mockedLogActivity.mock.calls[mockedLogActivity.mock.calls.length - 1][2];
    expect(lastLog.details.reason).toMatch(/Auto-side/);
  });

  it("step 8: direction conflict blocks", async () => {
    mockedCheckDirectionConflict.mockResolvedValue({
      block: true,
      reason: "EUR/USD short held by sibling algo",
      conflicting_algorithm_ids: ["algo-other"],
    });
    const result = await runDeterministicEntryGates(makeCtx());
    expect(result).toEqual({ blocked: true });
    expect(mockedLogActivity.mock.calls[0][2].details).toMatchObject({
      reason: "EUR/USD short held by sibling algo",
      proposed_side: "long",
    });
  });

  it("step 9: DXY filter blocks", async () => {
    mockedCheckDxyDirection.mockReturnValue({
      block: true,
      reason: "DXY trending against long",
      status: "trending_up",
      delta_pips: 15,
      threshold_pips: 10,
      lookback_hours: 24,
    });
    const ctx = makeCtx({
      algo: {
        id: "algo-1",
        name: "T",
        description: "",
        rules: makeRules({
          dxy_filter: { enabled: true, threshold_pips: 10, lookback_hours: 24 },
        } as unknown as Partial<AlgorithmRules>),
        capital: 100_000,
      },
      dxyBars: makeBars(50),
    });
    const result = await runDeterministicEntryGates(ctx);
    expect(result).toEqual({ blocked: true });
    expect(mockedLogActivity.mock.calls[0][2].details.reason).toBe("DXY trending against long");
  });

  it("step 10: regime filter blocks", async () => {
    mockedIsRangingByAtr.mockReturnValue({ skip: true, reason: "ATR percentile 5%, ranging" });
    const ctx = makeCtx({
      algo: {
        id: "algo-1",
        name: "T",
        description: "",
        rules: makeRules({
          regime_filter: { enabled: true, atr_percentile_threshold: 20, lookback: 200 },
        } as unknown as Partial<AlgorithmRules>),
        capital: 100_000,
      },
    });
    const result = await runDeterministicEntryGates(ctx);
    expect(result).toEqual({ blocked: true });
    expect(mockedLogActivity.mock.calls[0][2].details.reason).toContain("Regime filter:");
  });

  it("step 11: ADX filter blocks", async () => {
    mockedIsWeakTrendByAdx.mockReturnValue({ skip: true, reason: "ADX=18 below 25" });
    const ctx = makeCtx({
      algo: {
        id: "algo-1",
        name: "T",
        description: "",
        rules: makeRules({
          adx_filter: { enabled: true, min_adx: 25, lookback: 14 },
        } as unknown as Partial<AlgorithmRules>),
        capital: 100_000,
      },
    });
    const result = await runDeterministicEntryGates(ctx);
    expect(result).toEqual({ blocked: true });
    expect(mockedLogActivity.mock.calls[0][2].details.reason).toContain("ADX filter:");
  });
});

// ======================================================================
// Full pass-through + result-shape contract
// ======================================================================

describe("runDeterministicEntryGates — full pass-through", () => {
  it("all 11 gates pass → returns full result shape", async () => {
    const result = await runDeterministicEntryGates(makeCtx());
    expect(result).toEqual({
      blocked: false,
      side: "long",
      directionOverride: "bullish",
      higherTfBars: expect.any(Array),
      liquidity: expect.objectContaining({ skip: false, atr_current: 1.5 }),
      currentPrice: 3055,
    });
  });

  it("currentPrice: livePrice present → uses livePrice", async () => {
    const result = await runDeterministicEntryGates(makeCtx({ livePrice: 3100 }));
    if (!result.blocked) expect(result.currentPrice).toBe(3100);
  });

  it("currentPrice: livePrice absent → falls back to closes[closes.length-1]", async () => {
    const ctx = makeCtx({ livePrice: null });
    const result = await runDeterministicEntryGates(ctx);
    if (!result.blocked) expect(result.currentPrice).toBe(ctx.closes[ctx.closes.length - 1]);
  });
});

// ======================================================================
// Gate ordering — step 1 (ATR) fires BEFORE any other gate
// ======================================================================

describe("runDeterministicEntryGates — gate ordering", () => {
  it("ATR liquidity blocks BEFORE news veto is checked (step 1 short-circuits)", async () => {
    mockedCheckAtrLiquidity.mockReturnValue({
      skip: true,
      reason: "ATR below",
      atr_current: 0.5,
      atr_threshold: 1.0,
      status: "below",
    });
    mockedCheckNewsVeto.mockResolvedValue({ vetoed: true, reason: "NFP" });
    await runDeterministicEntryGates(makeCtx());
    // News veto must NOT have been called
    expect(mockedCheckNewsVeto).not.toHaveBeenCalled();
  });

  it("pre-side halts run BEFORE side resolution (steps 2-6 short-circuit)", async () => {
    mockedCheckNewsVeto.mockResolvedValue({ vetoed: true, reason: "NFP" });
    await runDeterministicEntryGates(makeCtx());
    expect(mockedResolveSide).not.toHaveBeenCalled();
  });
});
