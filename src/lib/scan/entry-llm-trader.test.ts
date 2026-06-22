/**
 * CB.T1 Tier 2 pass 4 — entry-llm-trader.ts orchestrator (2026-06-22 NIGHT LATE).
 *
 * Tests the LLM-trader entry orchestrator's dispatch contract — not the
 * deeper layers (those are mocked + tested in their own files).
 *
 * Key dispatch paths:
 *
 *  1. rules.llm_trader.enabled=false → {opened:0}, NO downstream calls
 *  2. Bar-timing gate fails → {opened:0}, signal_no_action logged
 *  3. Defensive gates blocked (flat only) → {opened:0}
 *  4. In-position → defensive gates SKIPPED (incident 2026-05-11 fix)
 *  5. Market-state gate blocked → {opened:0}
 *  6. LLM returns null decision → signal_no_action + recordLlmDecision NOT called
 *  7. Decision "hold" → logged with had_position context + return {opened:0}
 *  8. Decision "move_be" → delegates to executeLlmMoveBe
 *  9. Decision "exit" → delegates to executeLlmExit
 * 10. Decision "enter_long" / "enter_short" → delegates to executeLlmEnter
 *
 * Plus: hadPosition derivation, decisionId threading, dailyBars→buildLlmTraderCtx.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkBarStaleness } from "@/lib/algorithm/bar-staleness-gate";
import { checkAtrLiquidity } from "@/lib/algorithm/intraday-atr-gate";
import type { PriceBar } from "@/lib/market-data/types";
import type { AlgorithmRules } from "@/types/algorithm";
import type { PaperPosition } from "@/types/position";
import { computeLiveMarketState } from "./entry-gates";
import { buildLlmTraderCtx } from "./entry-llm-context";
import { checkDefensiveLlmGates } from "./entry-llm-defensive-gates";
import { checkLlmMarketStateGate } from "./entry-llm-market-state-gate";
import {
  executeLlmEnter,
  executeLlmExit,
  executeLlmMoveBe,
} from "./entry-llm-position-actions";
import { evaluateLlmTraderEntry } from "./entry-llm-trader";
import { logActivity } from "./helpers";
import { evaluateLlmTrader, isBarCloseScan } from "./llm-trader";
import { recordLlmDecision } from "./llm-trader-audit";
import type { EntryContext } from "./entry";
import type { AlgoContext } from "./entry-open";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/algorithm/bar-staleness-gate", () => ({ checkBarStaleness: vi.fn() }));
vi.mock("@/lib/algorithm/intraday-atr-gate", () => ({ checkAtrLiquidity: vi.fn() }));
vi.mock("./entry-gates", () => ({ computeLiveMarketState: vi.fn() }));
vi.mock("./entry-llm-context", () => ({ buildLlmTraderCtx: vi.fn() }));
vi.mock("./entry-llm-defensive-gates", () => ({ checkDefensiveLlmGates: vi.fn() }));
vi.mock("./entry-llm-market-state-gate", () => ({ checkLlmMarketStateGate: vi.fn() }));
vi.mock("./entry-llm-position-actions", () => ({
  executeLlmEnter: vi.fn(),
  executeLlmExit: vi.fn(),
  executeLlmMoveBe: vi.fn(),
}));
vi.mock("./helpers", () => ({ logActivity: vi.fn() }));
vi.mock("./llm-trader", () => ({
  evaluateLlmTrader: vi.fn(),
  isBarCloseScan: vi.fn(),
}));
vi.mock("./llm-trader-audit", () => ({ recordLlmDecision: vi.fn() }));

const mockedStaleness = vi.mocked(checkBarStaleness);
const mockedAtrLiquidity = vi.mocked(checkAtrLiquidity);
const mockedMarketState = vi.mocked(computeLiveMarketState);
const mockedBuildCtx = vi.mocked(buildLlmTraderCtx);
const mockedDefensiveGates = vi.mocked(checkDefensiveLlmGates);
const mockedMsGate = vi.mocked(checkLlmMarketStateGate);
const mockedEnter = vi.mocked(executeLlmEnter);
const mockedExit = vi.mocked(executeLlmExit);
const mockedMoveBe = vi.mocked(executeLlmMoveBe);
const mockedLogActivity = vi.mocked(logActivity);
const mockedEvalLlm = vi.mocked(evaluateLlmTrader);
const mockedIsBarClose = vi.mocked(isBarCloseScan);
const mockedRecord = vi.mocked(recordLlmDecision);

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

function makeRules(llmEnabled = true): AlgorithmRules {
  return {
    timeframe: "4h",
    asset_class: "commodities",
    side: "long",
    max_positions: 1,
    position_sizing: { type: "risk_per_trade", value: 1 },
    stop_loss: { type: "percentage", value: 1.5 },
    take_profit: { type: "percentage", value: 3 },
    entry_conditions: [],
    exit_conditions: [],
    llm_trader: llmEnabled ? { enabled: true, prompt_version: "v5" } : undefined,
  } as unknown as AlgorithmRules;
}

function makeCtx(positions: PaperPosition[] = []): EntryContext {
  const stub = Object.create(null) as Record<string, unknown>;
  const bars = makeBars(50);
  return {
    supabase: stub as unknown as SupabaseClient,
    userId: "user-1",
    algo: { id: "algo-1", name: "T", description: "", rules: makeRules(), capital: 10_000 } as AlgoContext,
    ticker: "XAU/USD",
    bars,
    closes: bars.map((b) => b.close),
    allOpenPositions: positions,
    livePrice: 3055,
    brokerCtx: null,
    dailyBars: makeBars(30),
    dxyBars: null,
  } as EntryContext;
}

function makePosition(): PaperPosition {
  return {
    id: "pos-existing",
    algorithm_id: "algo-1",
    ticker: "XAU/USD",
    side: "long",
    status: "open",
    entry_price: 3000,
    quantity: 1,
  } as unknown as PaperPosition;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedIsBarClose.mockReturnValue(true);
  mockedStaleness.mockReturnValue({ block: false, last_bar_date: "" });
  mockedAtrLiquidity.mockReturnValue({ skip: false, atr_current: 1.5, atr_threshold: 1.0, status: "ok" });
  mockedDefensiveGates.mockResolvedValue({ blocked: false });
  mockedMarketState.mockResolvedValue(null);
  mockedMsGate.mockResolvedValue({ blocked: false });
  mockedBuildCtx.mockResolvedValue({ currentTimestamp: "2026-06-22T12:00:00Z" } as Awaited<ReturnType<typeof buildLlmTraderCtx>>);
  mockedEvalLlm.mockResolvedValue({
    decision: { decision: "hold", confidence: 70, reasoning: "wait" },
    regime: "trend",
  } as Awaited<ReturnType<typeof evaluateLlmTrader>>);
  mockedRecord.mockResolvedValue("decision-id-1");
  mockedEnter.mockResolvedValue({ opened: 1, openEvent: { ticker: "XAU/USD", reason: "llm_enter_long", pnl: 0, price: 3055 } });
  mockedExit.mockResolvedValue({ opened: 0 });
  mockedMoveBe.mockResolvedValue({ opened: 0 });
  mockedLogActivity.mockResolvedValue(undefined);
});

// ======================================================================
// Configuration short-circuit
// ======================================================================

describe("evaluateLlmTraderEntry — config short-circuit", () => {
  it("rules.llm_trader.enabled=false → {opened:0}, NO downstream calls", async () => {
    const ctx = makeCtx();
    ctx.algo.rules = makeRules(false);
    const r = await evaluateLlmTraderEntry(ctx);
    expect(r).toEqual({ opened: 0 });
    expect(mockedIsBarClose).not.toHaveBeenCalled();
    expect(mockedDefensiveGates).not.toHaveBeenCalled();
    expect(mockedEvalLlm).not.toHaveBeenCalled();
  });
});

// ======================================================================
// Bar-timing gates
// ======================================================================

describe("evaluateLlmTraderEntry — bar-timing gates", () => {
  it("NOT bar-close + force=false → {opened:0} (skip LLM call entirely)", async () => {
    mockedIsBarClose.mockReturnValue(false);
    const ctx = makeCtx();
    ctx.force = false;
    const r = await evaluateLlmTraderEntry(ctx);
    expect(r).toEqual({ opened: 0 });
    expect(mockedEvalLlm).not.toHaveBeenCalled();
  });

  it("force=true bypasses bar-close gate", async () => {
    mockedIsBarClose.mockReturnValue(false);
    const ctx = makeCtx();
    ctx.force = true;
    await evaluateLlmTraderEntry(ctx);
    expect(mockedEvalLlm).toHaveBeenCalled();
  });

  it("bar-staleness block → signal_no_action logged + {opened:0}", async () => {
    mockedStaleness.mockReturnValue({
      block: true,
      reason: "Bar stale 70min > 35min threshold",
      bar_age_minutes: 70,
      threshold_minutes: 35,
      last_bar_date: "2026-06-22T11:00:00Z",
    });
    const r = await evaluateLlmTraderEntry(makeCtx());
    expect(r).toEqual({ opened: 0 });
    expect(mockedLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      "user-1",
      expect.objectContaining({
        event_type: "signal_no_action",
        details: expect.objectContaining({
          reason: "Bar stale 70min > 35min threshold",
          source: "llm_trader",
          bar_age_minutes: 70,
        }),
      })
    );
    expect(mockedEvalLlm).not.toHaveBeenCalled();
  });
});

// ======================================================================
// Defensive gates — flat-only invariant
// ======================================================================

describe("evaluateLlmTraderEntry — defensive gates flat-only", () => {
  it("flat + defensive gates blocked → {opened:0}", async () => {
    mockedDefensiveGates.mockResolvedValue({ blocked: true });
    const r = await evaluateLlmTraderEntry(makeCtx([]));
    expect(r).toEqual({ opened: 0 });
    expect(mockedEvalLlm).not.toHaveBeenCalled();
  });

  it("in-position → defensive gates SKIPPED (incident 2026-05-11 fix)", async () => {
    mockedDefensiveGates.mockResolvedValue({ blocked: true }); // would block if called
    const r = await evaluateLlmTraderEntry(makeCtx([makePosition()]));
    expect(mockedDefensiveGates).not.toHaveBeenCalled();
    // LLM still runs (so it can manage the open position)
    expect(mockedEvalLlm).toHaveBeenCalled();
    expect(r).toEqual({ opened: 0 }); // hold default
  });
});

// ======================================================================
// Market-state gate
// ======================================================================

describe("evaluateLlmTraderEntry — market-state gate", () => {
  it("market-state gate blocked → {opened:0}, NO LLM call", async () => {
    mockedMsGate.mockResolvedValue({ blocked: true });
    const r = await evaluateLlmTraderEntry(makeCtx());
    expect(r).toEqual({ opened: 0 });
    expect(mockedEvalLlm).not.toHaveBeenCalled();
  });
});

// ======================================================================
// LLM call failure
// ======================================================================

describe("evaluateLlmTraderEntry — LLM call failure", () => {
  it("LLM returns null decision → signal_no_action + recordLlmDecision NOT called", async () => {
    mockedEvalLlm.mockResolvedValue({
      decision: null,
      regime: "trend",
    } as Awaited<ReturnType<typeof evaluateLlmTrader>>);
    const r = await evaluateLlmTraderEntry(makeCtx());
    expect(r).toEqual({ opened: 0 });
    expect(mockedRecord).not.toHaveBeenCalled();
    expect(mockedLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      "user-1",
      expect.objectContaining({
        event_type: "signal_no_action",
        details: expect.objectContaining({
          reason: "LLM call failed (after retry)",
          source: "llm_trader",
        }),
      })
    );
  });
});

// ======================================================================
// Decision branches
// ======================================================================

describe("evaluateLlmTraderEntry — decision dispatch", () => {
  it("decision 'hold' → logged with had_position context + {opened:0}", async () => {
    mockedEvalLlm.mockResolvedValue({
      decision: { decision: "hold", confidence: 65, reasoning: "wait for confirmation" },
      regime: "ranging",
    } as Awaited<ReturnType<typeof evaluateLlmTrader>>);
    const r = await evaluateLlmTraderEntry(makeCtx([makePosition()]));
    expect(r).toEqual({ opened: 0 });
    expect(mockedLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      "user-1",
      expect.objectContaining({
        position_id: "pos-existing",
        event_type: "signal_no_action",
        details: expect.objectContaining({
          reason: "LLM decision: hold",
          source: "llm_trader",
          confidence: 65,
          had_position: "long",
        }),
      })
    );
  });

  it("decision 'hold' when FLAT → had_position='flat', no position_id field", async () => {
    mockedEvalLlm.mockResolvedValue({
      decision: { decision: "hold", confidence: 70, reasoning: "" },
      regime: "trend",
    } as Awaited<ReturnType<typeof evaluateLlmTrader>>);
    await evaluateLlmTraderEntry(makeCtx([]));
    const logArgs = mockedLogActivity.mock.calls[0][2];
    expect((logArgs as { details: { had_position: string } }).details.had_position).toBe("flat");
    expect("position_id" in logArgs).toBe(false);
  });

  it("decision 'move_be' → delegates to executeLlmMoveBe", async () => {
    mockedEvalLlm.mockResolvedValue({
      decision: { decision: "move_be", confidence: 75, reasoning: "" },
      regime: "trend",
    } as Awaited<ReturnType<typeof evaluateLlmTrader>>);
    await evaluateLlmTraderEntry(makeCtx([makePosition()]));
    expect(mockedMoveBe).toHaveBeenCalledTimes(1);
    expect(mockedEnter).not.toHaveBeenCalled();
    expect(mockedExit).not.toHaveBeenCalled();
  });

  it("decision 'exit' → delegates to executeLlmExit", async () => {
    mockedEvalLlm.mockResolvedValue({
      decision: { decision: "exit", confidence: 80, reasoning: "" },
      regime: "trend",
    } as Awaited<ReturnType<typeof evaluateLlmTrader>>);
    await evaluateLlmTraderEntry(makeCtx([makePosition()]));
    expect(mockedExit).toHaveBeenCalledTimes(1);
    expect(mockedEnter).not.toHaveBeenCalled();
    expect(mockedMoveBe).not.toHaveBeenCalled();
  });

  it("decision 'enter_long' → delegates to executeLlmEnter + threads decisionId", async () => {
    mockedEvalLlm.mockResolvedValue({
      decision: { decision: "enter_long", confidence: 82, reasoning: "" },
      regime: "trend",
    } as Awaited<ReturnType<typeof evaluateLlmTrader>>);
    const r = await evaluateLlmTraderEntry(makeCtx([]));
    expect(mockedEnter).toHaveBeenCalledTimes(1);
    // decisionId threaded from recordLlmDecision return value
    expect(mockedEnter.mock.calls[0][3]).toBe("decision-id-1");
    expect(r.opened).toBe(1);
  });

  it("decision 'enter_short' → also delegates to executeLlmEnter", async () => {
    mockedEvalLlm.mockResolvedValue({
      decision: { decision: "enter_short", confidence: 78, reasoning: "" },
      regime: "trend",
    } as Awaited<ReturnType<typeof evaluateLlmTrader>>);
    await evaluateLlmTraderEntry(makeCtx([]));
    expect(mockedEnter).toHaveBeenCalledTimes(1);
  });
});

// ======================================================================
// Audit threading
// ======================================================================

describe("evaluateLlmTraderEntry — audit threading", () => {
  it("recordLlmDecision called with hadPosition='flat' when no position", async () => {
    await evaluateLlmTraderEntry(makeCtx([]));
    expect(mockedRecord).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ hadPosition: "flat", source: "live" })
    );
  });

  it("recordLlmDecision called with hadPosition='long' when long position open", async () => {
    await evaluateLlmTraderEntry(makeCtx([makePosition()]));
    expect(mockedRecord).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ hadPosition: "long" })
    );
  });
});
