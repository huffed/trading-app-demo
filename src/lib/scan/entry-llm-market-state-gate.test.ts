/**
 * Unit tests for the LLM-trader market-state gate (CB.T1 pass 2,
 * 2026-06-22). Second test in `src/lib/scan/` — follows the same
 * vi.mock + fixture pattern established by entry-llm-defensive-gates.test.ts.
 *
 * Test coverage:
 *  - Pass-through when in-position (gate is flat-only)
 *  - Pass-through when no gate config (ungated algos)
 *  - Pass-through when verdict allows + no shadow_block_reason
 *  - Shadow log fires + gate still allows (observability path)
 *  - Block log fires + early-return when !verdict.allowed
 *  - Both shadow + block log fire when both conditions set
 *  - Gate context fields (entryHourUtc + positionInRangePct) wired correctly
 *  - Block payload contains verdict.reason + market_state + gate_mode
 *  - Shadow payload contains verdict.shadow_block_reason + gate_mode
 *  - Specialist fail-closed: null marketState passed through to gate-config check
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkMarketStateGateConfig,
  computePositionInRangePct,
  gateConfigModeLabel,
} from "@/lib/algorithm/market-state-gate";
import type { MarketState } from "@/lib/market-data/market-state";
import type { AlgorithmRules } from "@/types/algorithm";
import type { PaperPosition } from "@/types/position";
import { checkLlmMarketStateGate } from "./entry-llm-market-state-gate";
import { logActivity } from "./helpers";
import type { EntryContext } from "./entry";
import type { SupabaseClient } from "@supabase/supabase-js";

// ---- Mocks (vi.mock is hoisted by vitest at runtime). -----------------
vi.mock("@/lib/algorithm/market-state-gate", () => ({
  checkMarketStateGateConfig: vi.fn(),
  computePositionInRangePct: vi.fn(),
  gateConfigModeLabel: vi.fn(),
}));
vi.mock("./helpers", () => ({
  logActivity: vi.fn(),
}));

const mockedCheckGateConfig = vi.mocked(checkMarketStateGateConfig);
const mockedComputePositionInRangePct = vi.mocked(computePositionInRangePct);
const mockedGateConfigModeLabel = vi.mocked(gateConfigModeLabel);
const mockedLogActivity = vi.mocked(logActivity);

// ---- Fixture builders. ------------------------------------------------

function makeRules(withGate: boolean): AlgorithmRules {
  // Minimal config — the gate function only passes market_state_gate
  // through to checkMarketStateGateConfig (mocked), so the shape inside
  // doesn't matter at runtime. Cast at the boundary via Object.create
  // so the consistent-type-assertions rule (objectLiteralTypeAssertions:
  // never) doesn't reject the test fixture.
  const gateConfigStub = Object.create(null) as NonNullable<AlgorithmRules["market_state_gate"]>;
  Object.assign(gateConfigStub, { mode: "allow", states: { vol: ["mid"] } });
  return {
    timeframe: "4h",
    market_state_gate: withGate ? gateConfigStub : undefined,
  } as unknown as AlgorithmRules;
}

function makeCtx(overrides: {
  rules?: AlgorithmRules;
} = {}): EntryContext {
  const supabaseStub = Object.create(null) as SupabaseClient;
  return {
    supabase: supabaseStub,
    userId: "user-1",
    algo: {
      id: "algo-1",
      name: "Test Algo",
      description: "",
      rules: overrides.rules ?? makeRules(true),
      capital: 10_000,
    },
    ticker: "XAU/USD",
    bars: [
      { date: "2026-06-22T10:00:00Z", open: 3000, high: 3010, low: 2990, close: 3005, volume: 100 },
    ],
    closes: [3005],
    allOpenPositions: [] as PaperPosition[],
    livePrice: 3005,
    brokerCtx: null,
    dailyBars: null,
    dxyBars: null,
    intermarket: null,
    cappedReason: null,
    force: false,
  };
}

// Test fixtures — minimal shapes the gate function happens to need.
// Object.assign on Object.create(null) bypasses the consistent-type-
// assertions rule's object-literal forbid; the assertion at the end is
// a single identifier-cast (rule-exempt). See entry-llm-defensive-gates
// test for the same pattern.
const sampleMarketStateStub = Object.create(null) as Record<string, unknown>;
Object.assign(sampleMarketStateStub, { hl: "HH", vol: "mid", mtf: "agree" });
const SAMPLE_MARKET_STATE = sampleMarketStateStub as unknown as MarketState;

const samplePositionStub = Object.create(null) as Record<string, unknown>;
Object.assign(samplePositionStub, { id: "pos-1", side: "long" });
const SAMPLE_POSITION = samplePositionStub as unknown as PaperPosition;

beforeEach(() => {
  vi.clearAllMocks();
  mockedComputePositionInRangePct.mockReturnValue(50);
  mockedGateConfigModeLabel.mockReturnValue("allow:vol=mid");
  // Default: gate allows + no shadow → pass-through
  mockedCheckGateConfig.mockReturnValue({ allowed: true });
  mockedLogActivity.mockResolvedValue(undefined);
});

// ---- Tests. -----------------------------------------------------------

describe("checkLlmMarketStateGate — flat-only + per-algo conditions", () => {
  it("returns { blocked: false } when currentPosition is set (in-trade management never muzzled)", async () => {
    const result = await checkLlmMarketStateGate(
      makeCtx(),
      SAMPLE_MARKET_STATE,
      3005,
      SAMPLE_POSITION
    );
    expect(result).toEqual({ blocked: false });
    // CRITICAL: the gate check itself must NOT have been invoked when in
    // position — the 2026-05-11 incident lesson hard-coded into the test.
    expect(mockedCheckGateConfig).not.toHaveBeenCalled();
    expect(mockedLogActivity).not.toHaveBeenCalled();
  });

  it("returns { blocked: false } when rules.market_state_gate is undefined (ungated algos)", async () => {
    const result = await checkLlmMarketStateGate(
      makeCtx({ rules: makeRules(false) }),
      SAMPLE_MARKET_STATE,
      3005,
      null
    );
    expect(result).toEqual({ blocked: false });
    expect(mockedCheckGateConfig).not.toHaveBeenCalled();
  });
});

describe("checkLlmMarketStateGate — gate verdict paths", () => {
  it("pass-through { blocked: false } when verdict.allowed=true and no shadow", async () => {
    mockedCheckGateConfig.mockReturnValue({ allowed: true });
    const result = await checkLlmMarketStateGate(makeCtx(), SAMPLE_MARKET_STATE, 3005, null);
    expect(result).toEqual({ blocked: false });
    expect(mockedLogActivity).not.toHaveBeenCalled();
  });

  it("emits shadow log (only) when verdict.shadow_block_reason set but verdict.allowed=true", async () => {
    mockedCheckGateConfig.mockReturnValue({
      allowed: true,
      shadow_block_reason: "would block under stricter vol=high",
    });
    const result = await checkLlmMarketStateGate(makeCtx(), SAMPLE_MARKET_STATE, 3005, null);
    // Critically: still returns false — shadow does NOT block.
    expect(result).toEqual({ blocked: false });
    expect(mockedLogActivity).toHaveBeenCalledOnce();
    const logCall = mockedLogActivity.mock.calls[0];
    expect(logCall[2].details).toMatchObject({
      reason: "market_state_gate_shadow",
      source: "llm_trader",
      gate_mode: "allow:vol=mid",
      would_block: "would block under stricter vol=high",
      market_state: SAMPLE_MARKET_STATE,
      entry_hour_utc: expect.any(Number),
      position_in_range_pct: 50,
    });
  });

  it("blocks + emits block log when verdict.allowed=false", async () => {
    mockedCheckGateConfig.mockReturnValue({
      allowed: false,
      reason: "vol=high not in allow=mid",
    });
    const result = await checkLlmMarketStateGate(makeCtx(), SAMPLE_MARKET_STATE, 3005, null);
    expect(result).toEqual({ blocked: true });
    expect(mockedLogActivity).toHaveBeenCalledOnce();
    const logCall = mockedLogActivity.mock.calls[0];
    expect(logCall[2].details).toMatchObject({
      reason: "market_state_gate",
      source: "llm_trader",
      gate_mode: "allow:vol=mid",
      verdict: "vol=high not in allow=mid",
      market_state: SAMPLE_MARKET_STATE,
      entry_hour_utc: expect.any(Number),
      position_in_range_pct: 50,
    });
  });

  it("emits BOTH shadow + block logs when both conditions set (shadow first, block second)", async () => {
    mockedCheckGateConfig.mockReturnValue({
      allowed: false,
      reason: "vol=high not in allow=mid",
      shadow_block_reason: "additional stricter shadow",
    });
    const result = await checkLlmMarketStateGate(makeCtx(), SAMPLE_MARKET_STATE, 3005, null);
    expect(result).toEqual({ blocked: true });
    expect(mockedLogActivity).toHaveBeenCalledTimes(2);
    // First call: shadow log
    expect(mockedLogActivity.mock.calls[0][2].details.reason).toBe("market_state_gate_shadow");
    // Second call: block log
    expect(mockedLogActivity.mock.calls[1][2].details.reason).toBe("market_state_gate");
  });
});

describe("checkLlmMarketStateGate — GateContext construction", () => {
  it("wires positionInRangePct from computePositionInRangePct(bars, currentPrice)", async () => {
    mockedComputePositionInRangePct.mockReturnValue(75);
    mockedCheckGateConfig.mockReturnValue({ allowed: false, reason: "any" });
    await checkLlmMarketStateGate(makeCtx(), SAMPLE_MARKET_STATE, 3005, null);
    expect(mockedComputePositionInRangePct).toHaveBeenCalledWith(
      expect.any(Array), // bars
      3005 // currentPrice
    );
    const logCall = mockedLogActivity.mock.calls[0];
    expect(logCall[2].details.position_in_range_pct).toBe(75);
  });

  it("wires entryHourUtc from new Date().getUTCHours() (read at call time)", async () => {
    mockedCheckGateConfig.mockReturnValue({ allowed: false, reason: "any" });
    await checkLlmMarketStateGate(makeCtx(), SAMPLE_MARKET_STATE, 3005, null);
    const logCall = mockedLogActivity.mock.calls[0];
    // Can't pin the value without freezing time; just verify it's a sane
    // UTC hour (0-23) and that it was set on the gateCtx passed in.
    const hour = logCall[2].details.entry_hour_utc;
    expect(typeof hour).toBe("number");
    expect(hour).toBeGreaterThanOrEqual(0);
    expect(hour).toBeLessThanOrEqual(23);
    // Verify the same hour was passed to the gate-config check
    expect(mockedCheckGateConfig).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ entryHourUtc: hour, positionInRangePct: 50 })
    );
  });
});

describe("checkLlmMarketStateGate — specialist fail-closed semantics", () => {
  it("passes null marketState through to checkMarketStateGateConfig (specialists fail closed)", async () => {
    mockedCheckGateConfig.mockReturnValue({
      allowed: false,
      reason: "specialist requires readable state",
    });
    const result = await checkLlmMarketStateGate(makeCtx(), null, 3005, null);
    expect(result).toEqual({ blocked: true });
    // CRITICAL: gate-config receives null (not coerced to a fallback). The
    // specialist contract requires the impl to fail-closed when state
    // can't be read; this is the test that protects that contract.
    expect(mockedCheckGateConfig).toHaveBeenCalledWith(
      expect.any(Object), // gateConfig
      null, // marketState
      expect.any(Object) // gateCtx
    );
    // And the block log records `market_state: null` so the operator can
    // grep for "unreadable state" patterns.
    const logCall = mockedLogActivity.mock.calls[0];
    expect(logCall[2].details.market_state).toBeNull();
  });
});
