/**
 * CB.T1 Tier 2 pass 3 — entry-llm-enter.ts (2026-06-22 NIGHT LATE).
 *
 * LLM-trader enter-side dispatch. Tests verify:
 *
 *  - enter-gate-blocked → {opened:0}, no signal_detected log, no openPosition
 *  - happy path → signal_detected logged with LLM context (regime, direction,
 *    confidence, reasoning, atr_current, market_state) + openPosition called
 *    with rules.side OVERRIDDEN to llmSide + adaptiveTpCtx populated +
 *    cohortFromCaller threaded
 *  - decisionId + opened.paperPositionId → linkLlmDecisionToPosition called
 *  - missing decisionId OR no paperPositionId → link NOT called
 *  - regime "n/a" → cohort.regime undefined (don't pollute attribution)
 *  - marketState null → cohort.market_state field omitted
 *  - dailyBars empty/null → adaptiveTpCtx.dailyAtr = 0 (deterministic short-circuit)
 *
 * The deeper layers (`checkLlmEnterGates`, `openPosition`,
 * `linkLlmDecisionToPosition`, `dailyAtrFromBars`) are mocked — we test
 * the orchestrator's dispatch contract, not the deeper implementations.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AtrLiquidityResult } from "@/lib/algorithm/intraday-atr-gate";
import { dailyAtrFromBars } from "@/lib/algorithm/structural-sl";
import type { MarketState } from "@/lib/market-data/market-state";
import type { PriceBar } from "@/lib/market-data/types";
import type { AlgorithmRules } from "@/types/algorithm";
import { executeLlmEnter } from "./entry-llm-enter";
import { checkLlmEnterGates } from "./entry-llm-enter-gates";
import { openPosition, type AlgoContext } from "./entry-open";
import { logActivity } from "./helpers";
import { linkLlmDecisionToPosition } from "./llm-trader-audit";
import type { EntryContext } from "./entry";
import type { LlmTraderDecision, LlmTraderEvaluation } from "./llm-trader";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/algorithm/structural-sl", () => ({
  dailyAtrFromBars: vi.fn(),
}));
vi.mock("./entry-llm-enter-gates", () => ({
  checkLlmEnterGates: vi.fn(),
}));
vi.mock("./entry-open", () => ({
  openPosition: vi.fn(),
}));
vi.mock("./helpers", () => ({ logActivity: vi.fn() }));
vi.mock("./llm-trader-audit", () => ({
  linkLlmDecisionToPosition: vi.fn(),
}));

const mockedDailyAtr = vi.mocked(dailyAtrFromBars);
const mockedCheckGates = vi.mocked(checkLlmEnterGates);
const mockedOpenPosition = vi.mocked(openPosition);
const mockedLogActivity = vi.mocked(logActivity);
const mockedLink = vi.mocked(linkLlmDecisionToPosition);

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

function makeRules(): AlgorithmRules {
  return {
    timeframe: "4h",
    asset_class: "commodities",
    side: "long", // will be overridden to LLM's pick
    max_positions: 1,
    position_sizing: { type: "risk_per_trade", value: 1 },
    stop_loss: { type: "percentage", value: 1.5 },
    take_profit: { type: "percentage", value: 3 },
    entry_conditions: [],
    exit_conditions: [],
  } as unknown as AlgorithmRules;
}

function makeCtx(): EntryContext {
  const stub = Object.create(null) as Record<string, unknown>;
  const bars = makeBars(50);
  return {
    supabase: stub as unknown as SupabaseClient,
    userId: "user-1",
    algo: {
      id: "algo-1",
      name: "T",
      description: "",
      rules: makeRules(),
      capital: 10_000,
    } as AlgoContext,
    ticker: "XAU/USD",
    bars,
    closes: bars.map((b) => b.close),
    allOpenPositions: [],
    livePrice: 3055,
    brokerCtx: null,
    dailyBars: makeBars(30),
  } as EntryContext;
}

const decisionLong: LlmTraderDecision = {
  decision: "enter_long",
  confidence: 80,
  reasoning: "bullish swing",
};

const evaluation: LlmTraderEvaluation = {
  regime: "trend",
  promptVersion: "v5",
} as unknown as LlmTraderEvaluation;

const liquidity: AtrLiquidityResult = {
  skip: false,
  atr_current: 1.5,
  atr_threshold: 1.0,
  status: "ok",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockedDailyAtr.mockReturnValue(2.5);
  mockedCheckGates.mockResolvedValue({ blocked: false });
  mockedOpenPosition.mockResolvedValue({
    opened: 1,
    openEvent: { ticker: "XAU/USD", reason: "llm_enter_long", pnl: 0, price: 3055 },
    paperPositionId: "pos-new-1",
  });
  mockedLogActivity.mockResolvedValue(undefined);
  mockedLink.mockResolvedValue(undefined);
});

// ======================================================================
// Enter-gate-blocked short-circuit
// ======================================================================

describe("executeLlmEnter — enter-gate-blocked short-circuit", () => {
  it("checkLlmEnterGates blocked → {opened:0}, NO signal_detected log, NO openPosition", async () => {
    mockedCheckGates.mockResolvedValue({ blocked: true });
    const r = await executeLlmEnter(makeCtx(), decisionLong, evaluation, null, null, liquidity, null);
    expect(r).toEqual({ opened: 0 });
    expect(mockedLogActivity).not.toHaveBeenCalled();
    expect(mockedOpenPosition).not.toHaveBeenCalled();
  });
});

// ======================================================================
// Happy path: signal_detected log + openPosition with overrides
// ======================================================================

describe("executeLlmEnter — happy path log + openPosition", () => {
  it("signal_detected emitted with LLM context (regime, direction, confidence, reasoning, atr, market_state)", async () => {
    const ms = { mtf: "trend", vol: "expansion", range: "discount", dxy: "n/a" } as MarketState;
    await executeLlmEnter(makeCtx(), decisionLong, evaluation, null, ms, liquidity, null);
    expect(mockedLogActivity).toHaveBeenCalledTimes(1);
    expect(mockedLogActivity.mock.calls[0][2]).toMatchObject({
      event_type: "signal_detected",
      ticker: "XAU/USD",
      details: {
        source: "llm_trader",
        regime: "trend",
        direction: "long",
        confidence: 80,
        llm_reasoning: "bullish swing",
        atr_current: 1.5,
        atr_threshold: 1.0,
        market_state: ms,
      },
    });
  });

  it("rules.side OVERRIDDEN to LLM's side when LLM picks short", async () => {
    const decisionShort: LlmTraderDecision = { decision: "enter_short", confidence: 75, reasoning: "" };
    await executeLlmEnter(makeCtx(), decisionShort, evaluation, null, null, liquidity, null);
    const openArgs = mockedOpenPosition.mock.calls[0][0];
    expect(openArgs.algo.rules.side).toBe("short");
  });

  it("rules.side OVERRIDDEN to LLM's side when LLM picks long", async () => {
    await executeLlmEnter(makeCtx(), decisionLong, evaluation, null, null, liquidity, null);
    const openArgs = mockedOpenPosition.mock.calls[0][0];
    expect(openArgs.algo.rules.side).toBe("long");
  });

  it("adaptiveTpCtx populated with regime + dailyAtr from dailyBars", async () => {
    mockedDailyAtr.mockReturnValue(3.7);
    await executeLlmEnter(makeCtx(), decisionLong, evaluation, null, null, liquidity, makeBars(30));
    const openArgs = mockedOpenPosition.mock.calls[0][0];
    expect(openArgs.adaptiveTpCtx).toEqual({ regime: "trend", dailyAtr: 3.7 });
  });

  it("dailyBars empty/null → adaptiveTpCtx.dailyAtr = 0 (deterministic short-circuit)", async () => {
    await executeLlmEnter(makeCtx(), decisionLong, evaluation, null, null, liquidity, null);
    expect(mockedDailyAtr).not.toHaveBeenCalled();
    const openArgs = mockedOpenPosition.mock.calls[0][0];
    expect(openArgs.adaptiveTpCtx.dailyAtr).toBe(0);
  });
});

// ======================================================================
// cohortFromCaller threading
// ======================================================================

describe("executeLlmEnter — cohort attribution", () => {
  it("regime present + marketState present → cohort populated with both", async () => {
    const ms = { mtf: "trend", vol: "expansion", range: "discount", dxy: "n/a" } as MarketState;
    await executeLlmEnter(makeCtx(), decisionLong, evaluation, null, ms, liquidity, null);
    const openArgs = mockedOpenPosition.mock.calls[0][0];
    expect(openArgs.cohortFromCaller).toEqual({ regime: "trend", market_state: ms });
  });

  it('regime "n/a" → cohort.regime undefined (don\'t pollute attribution with sentinel)', async () => {
    const evalNa: LlmTraderEvaluation = { regime: "n/a" } as unknown as LlmTraderEvaluation;
    await executeLlmEnter(makeCtx(), decisionLong, evalNa, null, null, liquidity, null);
    const openArgs = mockedOpenPosition.mock.calls[0][0];
    expect(openArgs.cohortFromCaller.regime).toBeUndefined();
  });

  it("marketState null → cohort.market_state field OMITTED (not set to null)", async () => {
    await executeLlmEnter(makeCtx(), decisionLong, evaluation, null, null, liquidity, null);
    const openArgs = mockedOpenPosition.mock.calls[0][0];
    expect("market_state" in openArgs.cohortFromCaller).toBe(false);
  });
});

// ======================================================================
// Decision audit linking
// ======================================================================

describe("executeLlmEnter — decision audit linking", () => {
  it("decisionId + opened.paperPositionId → linkLlmDecisionToPosition called", async () => {
    await executeLlmEnter(makeCtx(), decisionLong, evaluation, "decision-uuid-1", null, liquidity, null);
    expect(mockedLink).toHaveBeenCalledWith(expect.anything(), "decision-uuid-1", "pos-new-1");
  });

  it("decisionId null → link NOT called", async () => {
    await executeLlmEnter(makeCtx(), decisionLong, evaluation, null, null, liquidity, null);
    expect(mockedLink).not.toHaveBeenCalled();
  });

  it("decisionId present but openPosition didn't produce paperPositionId → link NOT called", async () => {
    mockedOpenPosition.mockResolvedValue({ opened: 0 });
    await executeLlmEnter(makeCtx(), decisionLong, evaluation, "decision-uuid-1", null, liquidity, null);
    expect(mockedLink).not.toHaveBeenCalled();
  });
});
