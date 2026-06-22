/**
 * Unit tests for the entry orchestrator (CB.T1.9, 2026-06-22 NIGHT).
 *
 * `evaluateEntry` is the top-level dispatch:
 *  1. LLM-trader dispatch (rules.llm_trader.enabled → delegate)
 *  2. Deterministic gate ladder (runDeterministicEntryGates)
 *  3. Entry conditions evaluation (technical + pattern; sentiment filtered)
 *  4. Conviction multiplier
 *  5. Sentiment block (configured sentiment + signal != buy → block)
 *  6. Broker spread gate (when brokerCtx)
 *  7. Capped near-miss log + return (when cappedReason)
 *  8. signal_detected log + openPosition
 *
 * Each branch above is a separate test. The orchestrator's sub-helpers
 * are tested in their own files (entry-llm-defensive-gates,
 * entry-deterministic-gates, entry-conviction, entry-gates, entry-open).
 * This file locks the DISPATCH contract — that the right helper fires at
 * the right time and a block at step N short-circuits step N+1.
 *
 * Coverage (14 tests):
 *
 *  LLM-trader dispatch (2):
 *   - rules.llm_trader.enabled=true → delegates, NO deterministic gates
 *   - LLM result threaded through unchanged
 *
 *  Early-return short-circuits (3):
 *   - runDeterministicEntryGates blocked → {opened:0}, NO conditions check
 *   - checkEntryConditions {pass:false} → {opened:0}, NO sentiment/spread/open
 *   - Sentiment configured + signal != buy → {opened:0}, NO spread/open
 *
 *  Brokerless + sentiment-free paths (2):
 *   - No sentiment conditions → sentiment skipped (undefined), proceeds
 *   - No brokerCtx → spread gate SKIPPED entirely (no checkBrokerSpread call)
 *
 *  Broker spread gate (2):
 *   - brokerCtx + spread.block=true → {opened:0}, NO openPosition, logActivity
 *   - brokerCtx + spread allowed → proceeds to openPosition (telemetry threaded)
 *
 *  Capped near-miss (1):
 *   - cappedReason present → logCappedNearMiss + {opened:0}, NO openPosition
 *
 *  Conditions filtering (1):
 *   - checkEntryConditions called with technical+pattern only (sentiment filtered out)
 *
 *  Happy path (2):
 *   - All gates pass → signal_detected logged + openPosition called + result threaded
 *   - openPosition's openEvent threaded through verbatim to result
 *
 *  Pass-through args (1):
 *   - directionOverride + higherTfBars from runDeterministicEntryGates →
 *     threaded into checkEntryConditions; dailyBars → openPosition
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkBrokerSpread } from "@/lib/algorithm/spread-gate";
import type { PriceBar } from "@/lib/market-data/types";
import { evaluateLiveSignal } from "@/lib/signals/evaluate-live";
import type { AlgorithmRules } from "@/types/algorithm";
import { evaluateEntry, type EntryContext } from "./entry";
import {
  checkEntryConditions,
  normalize,
  pickConvictionMultiplier,
} from "./entry-conviction";
import { runDeterministicEntryGates } from "./entry-deterministic-gates";
import { evaluateLlmTraderEntry } from "./entry-llm-trader";
import { openPosition, type AlgoContext } from "./entry-open";
import { logActivity } from "./helpers";
import type { BrokerExecutionContext } from "./live-execution";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/algorithm/spread-gate", () => ({ checkBrokerSpread: vi.fn() }));
vi.mock("@/lib/signals/evaluate-live", () => ({ evaluateLiveSignal: vi.fn() }));
vi.mock("./entry-conviction", () => ({
  checkEntryConditions: vi.fn(),
  normalize: vi.fn(),
  pickConvictionMultiplier: vi.fn(),
}));
vi.mock("./entry-deterministic-gates", () => ({ runDeterministicEntryGates: vi.fn() }));
vi.mock("./entry-llm-trader", () => ({ evaluateLlmTraderEntry: vi.fn() }));
vi.mock("./entry-open", () => ({ openPosition: vi.fn() }));
vi.mock("./helpers", () => ({ logActivity: vi.fn() }));

const mockedCheckSpread = vi.mocked(checkBrokerSpread);
const mockedEvalLive = vi.mocked(evaluateLiveSignal);
const mockedCheckConds = vi.mocked(checkEntryConditions);
const mockedNormalize = vi.mocked(normalize);
const mockedPickConv = vi.mocked(pickConvictionMultiplier);
const mockedRunGates = vi.mocked(runDeterministicEntryGates);
const mockedLlmTrader = vi.mocked(evaluateLlmTraderEntry);
const mockedOpen = vi.mocked(openPosition);
const mockedLogActivity = vi.mocked(logActivity);

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

function makeRules(overrides: Partial<AlgorithmRules> = {}): AlgorithmRules {
  return {
    timeframe: "4h",
    asset_class: "commodities",
    side: "long",
    max_positions: 5,
    position_sizing: { type: "risk_per_trade", value: 1 },
    stop_loss: { type: "percentage", value: 1.5 },
    take_profit: { type: "percentage", value: 3 },
    entry_conditions: [],
    exit_conditions: [],
    entry_logic: "all",
    ...overrides,
  } as unknown as AlgorithmRules;
}

function makeAlgo(rules: Partial<AlgorithmRules> = {}): AlgoContext {
  return {
    id: "algo-1",
    name: "Test",
    description: "",
    rules: makeRules(rules),
    capital: 100_000,
  } as AlgoContext;
}

function makeCtx(overrides: Partial<EntryContext> = {}): EntryContext {
  const supabaseStub = Object.create(null) as Record<string, unknown>;
  const bars = makeBars(50);
  return {
    supabase: supabaseStub as unknown as SupabaseClient,
    userId: "user-1",
    algo: makeAlgo(),
    ticker: "XAU/USD",
    bars,
    closes: bars.map((b) => b.close),
    allOpenPositions: [],
    livePrice: 3055,
    brokerCtx: null,
    dailyBars: null,
    dxyBars: null,
    intermarket: null,
    cappedReason: null,
    force: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Pass-through defaults — each test overrides what it's testing.
  mockedRunGates.mockResolvedValue({
    blocked: false,
    side: "long",
    directionOverride: "bullish",
    higherTfBars: [],
    liquidity: { skip: false, atr_current: 1.5, atr_threshold: 1.0, status: "ok" },
    currentPrice: 3055,
  });
  mockedNormalize.mockReturnValue([]);
  mockedCheckConds.mockResolvedValue({
    pass: true,
    met: 2,
    total: 2,
    fired: [],
  });
  mockedPickConv.mockReturnValue(1);
  mockedEvalLive.mockResolvedValue({ signal: "buy", confidence: 80, reasoning: "ok" });
  mockedCheckSpread.mockResolvedValue({
    block: false,
    status: "ok",
    observed_spread_pips: 0.3,
    threshold_pips: 1.0,
    typical_pips: 0.4,
    bid: 3054.7,
    ask: 3055.3,
  });
  mockedOpen.mockResolvedValue({
    opened: 1,
    openEvent: { ticker: "XAU/USD", reason: "signal_buy", pnl: 0, price: 3055 },
  });
  mockedLlmTrader.mockResolvedValue({ opened: 0 });
  mockedLogActivity.mockResolvedValue(undefined);
});

// ======================================================================
// LLM-trader dispatch
// ======================================================================

describe("evaluateEntry — LLM-trader dispatch", () => {
  it("rules.llm_trader.enabled=true → delegates to evaluateLlmTraderEntry, NO deterministic gates", async () => {
    mockedLlmTrader.mockResolvedValue({
      opened: 1,
      openEvent: { ticker: "XAU/USD", reason: "llm_enter_long", pnl: 0, price: 3055 },
    });
    const ctx = makeCtx({ algo: makeAlgo({ llm_trader: { enabled: true } } as unknown as Partial<AlgorithmRules>) });
    const r = await evaluateEntry(ctx);
    expect(mockedLlmTrader).toHaveBeenCalledTimes(1);
    expect(mockedLlmTrader).toHaveBeenCalledWith(ctx); // FULL context passed unchanged
    expect(mockedRunGates).not.toHaveBeenCalled();
    expect(mockedCheckConds).not.toHaveBeenCalled();
    expect(mockedOpen).not.toHaveBeenCalled();
    expect(r).toEqual({
      opened: 1,
      openEvent: { ticker: "XAU/USD", reason: "llm_enter_long", pnl: 0, price: 3055 },
    });
  });

  it("LLM-trader returning {opened:0} threads through unchanged", async () => {
    mockedLlmTrader.mockResolvedValue({ opened: 0 });
    const ctx = makeCtx({ algo: makeAlgo({ llm_trader: { enabled: true } } as unknown as Partial<AlgorithmRules>) });
    const r = await evaluateEntry(ctx);
    expect(r).toEqual({ opened: 0 });
  });
});

// ======================================================================
// Early-return short-circuits
// ======================================================================

describe("evaluateEntry — early-return short-circuits", () => {
  it("runDeterministicEntryGates blocked → {opened:0}, NO conditions check", async () => {
    mockedRunGates.mockResolvedValue({ blocked: true });
    const r = await evaluateEntry(makeCtx());
    expect(r).toEqual({ opened: 0 });
    expect(mockedCheckConds).not.toHaveBeenCalled();
    expect(mockedEvalLive).not.toHaveBeenCalled();
    expect(mockedCheckSpread).not.toHaveBeenCalled();
    expect(mockedOpen).not.toHaveBeenCalled();
  });

  it("checkEntryConditions {pass:false} → {opened:0}, NO sentiment/spread/open", async () => {
    mockedCheckConds.mockResolvedValue({ pass: false, met: 1, total: 2, fired: [] });
    const r = await evaluateEntry(makeCtx());
    expect(r).toEqual({ opened: 0 });
    expect(mockedPickConv).not.toHaveBeenCalled();
    expect(mockedEvalLive).not.toHaveBeenCalled();
    expect(mockedCheckSpread).not.toHaveBeenCalled();
    expect(mockedOpen).not.toHaveBeenCalled();
  });

  it("sentiment configured + signal != buy → log signal_no_action + {opened:0}, NO spread/open", async () => {
    // normalize returns at least one sentiment condition
    mockedNormalize.mockReturnValue([{ type: "sentiment", source: "newsapi" }] as unknown as ReturnType<typeof normalize>);
    mockedEvalLive.mockResolvedValue({ signal: "sell", confidence: 70, reasoning: "bearish news" });
    const r = await evaluateEntry(makeCtx());
    expect(r).toEqual({ opened: 0 });
    expect(mockedCheckSpread).not.toHaveBeenCalled();
    expect(mockedOpen).not.toHaveBeenCalled();
    expect(mockedLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      "user-1",
      expect.objectContaining({
        event_type: "signal_no_action",
        details: expect.objectContaining({
          reason: "Sentiment conditions not met",
          signal: "sell",
        }),
      })
    );
  });
});

// ======================================================================
// Brokerless + sentiment-free paths
// ======================================================================

describe("evaluateEntry — sentiment-free + brokerless paths", () => {
  it("no sentiment conditions configured → evaluateLiveSignal NOT called, proceeds", async () => {
    mockedNormalize.mockReturnValue([]); // no sentiment
    const r = await evaluateEntry(makeCtx());
    expect(mockedEvalLive).not.toHaveBeenCalled();
    expect(r.opened).toBe(1); // proceeded to openPosition
  });

  it("brokerCtx=null → checkBrokerSpread NOT called, proceeds to openPosition", async () => {
    const r = await evaluateEntry(makeCtx({ brokerCtx: null }));
    expect(mockedCheckSpread).not.toHaveBeenCalled();
    expect(mockedOpen).toHaveBeenCalledTimes(1);
    expect(r.opened).toBe(1);
  });
});

// ======================================================================
// Broker spread gate
// ======================================================================

describe("evaluateEntry — broker spread gate", () => {
  it("brokerCtx + spread.block=true → log signal_no_action + {opened:0}, NO openPosition", async () => {
    mockedCheckSpread.mockResolvedValue({
      block: true,
      reason: "spread 2.5pip > 1pip threshold",
      status: "wide",
      observed_spread_pips: 2.5,
      threshold_pips: 1.0,
      typical_pips: 0.4,
      bid: 3054,
      ask: 3056.5,
    });
    const brokerCtx = { adapter: {}, conn: {} } as unknown as BrokerExecutionContext;
    const r = await evaluateEntry(makeCtx({ brokerCtx }));
    expect(r).toEqual({ opened: 0 });
    expect(mockedOpen).not.toHaveBeenCalled();
    expect(mockedLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      "user-1",
      expect.objectContaining({
        event_type: "signal_no_action",
        details: expect.objectContaining({
          reason: "spread 2.5pip > 1pip threshold",
          observed_spread_pips: 2.5,
        }),
      })
    );
  });

  it("brokerCtx + spread allowed → proceeds to openPosition", async () => {
    const brokerCtx = { adapter: {}, conn: {} } as unknown as BrokerExecutionContext;
    const r = await evaluateEntry(makeCtx({ brokerCtx }));
    expect(mockedCheckSpread).toHaveBeenCalledWith({}, {}, "XAU/USD");
    expect(mockedOpen).toHaveBeenCalledTimes(1);
    expect(r.opened).toBe(1);
  });
});

// ======================================================================
// Capped near-miss
// ======================================================================

describe("evaluateEntry — capped near-miss", () => {
  it("cappedReason present → logCappedNearMiss + {opened:0}, NO openPosition", async () => {
    const r = await evaluateEntry(makeCtx({ cappedReason: "Capped: 5/5 positions open" }));
    expect(r).toEqual({ opened: 0 });
    expect(mockedOpen).not.toHaveBeenCalled();
    // The capped log includes would_have_entered:true so the operator sees firings during slot-full windows
    expect(mockedLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      "user-1",
      expect.objectContaining({
        event_type: "signal_no_action",
        details: expect.objectContaining({
          reason: "Capped: 5/5 positions open",
          would_have_entered: true,
        }),
      })
    );
  });
});

// ======================================================================
// Conditions filtering
// ======================================================================

describe("evaluateEntry — conditions filtering", () => {
  it("checkEntryConditions receives technical+pattern only (sentiment filtered out)", async () => {
    mockedNormalize.mockReturnValue([
      { type: "technical", indicator: "rsi", operator: "<", value: 30 },
      { type: "pattern", pattern: "fvg", lookback: 5 },
      { type: "sentiment", source: "newsapi" },
    ] as unknown as ReturnType<typeof normalize>);
    await evaluateEntry(makeCtx());
    // The 5th positional arg to checkEntryConditions is the evaluable conditions array
    const evaluableArg = mockedCheckConds.mock.calls[0][4];
    expect(evaluableArg).toHaveLength(2); // tech + pattern only
    expect(evaluableArg.map((c: { type: string }) => c.type).sort()).toEqual(["pattern", "technical"]);
  });
});

// ======================================================================
// Happy path
// ======================================================================

describe("evaluateEntry — happy path", () => {
  it("all gates pass → signal_detected logged + openPosition called + result threaded", async () => {
    const r = await evaluateEntry(makeCtx());
    // signal_detected emitted (not signal_no_action)
    const detectedLog = mockedLogActivity.mock.calls.find(
      (c) => (c[2] as { event_type: string }).event_type === "signal_detected"
    );
    expect(detectedLog).toBeDefined();
    expect(mockedOpen).toHaveBeenCalledTimes(1);
    expect(r).toEqual({
      opened: 1,
      openEvent: { ticker: "XAU/USD", reason: "signal_buy", pnl: 0, price: 3055 },
    });
  });

  it("openPosition's result threaded verbatim (no modification)", async () => {
    const expectedEvent = { ticker: "EUR/USD", reason: "custom_reason", pnl: 42, price: 1.1023 };
    mockedOpen.mockResolvedValue({ opened: 1, openEvent: expectedEvent });
    const r = await evaluateEntry(makeCtx());
    expect(r.openEvent).toBe(expectedEvent); // same reference
  });
});

// ======================================================================
// Pass-through args (directionOverride + higherTfBars + dailyBars)
// ======================================================================

describe("evaluateEntry — pass-through args from gate result", () => {
  it("directionOverride + higherTfBars threaded into checkEntryConditions; dailyBars into openPosition", async () => {
    const higherTfBars = makeBars(30);
    const dailyBars = makeBars(30);
    mockedRunGates.mockResolvedValue({
      blocked: false,
      side: "short",
      directionOverride: "bearish",
      higherTfBars,
      liquidity: { skip: false, atr_current: 2.5, atr_threshold: 1.5, status: "ok" },
      currentPrice: 3055,
    });
    await evaluateEntry(makeCtx({ dailyBars }));
    // checkEntryConditions positional args: (supabase, userId, algoId, ticker,
    //   evaluableEntry, bars, closes, timeframe, entry_logic, directionOverride, higherTfBars)
    const checkCondsArgs = mockedCheckConds.mock.calls[0];
    expect(checkCondsArgs[9]).toBe("bearish");
    expect(checkCondsArgs[10]).toBe(higherTfBars);
    // openPosition receives dailyBarsForLevels
    const openArgs = mockedOpen.mock.calls[0][0];
    expect(openArgs.dailyBarsForLevels).toBe(dailyBars);
  });
});
