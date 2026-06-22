/**
 * Unit tests for scan-engine helpers (CB.T1 pass 12, 2026-06-22).
 * Twelfth test in `src/lib/scan/`. Tests the 3 exports:
 *  - calculatePositionSize (sizing dispatch over 5 sizing.type variants)
 *  - calculateRiskPrices (entry/SL/TP geometry — long + short mirrored)
 *  - logActivity (audit write — error gets surfaced via logger.error)
 *
 * Coverage (~24 tests):
 *  calculatePositionSize:
 *   - Insufficient capital after open positions → null
 *   - percentage_of_capital: notional = capital × value/100
 *   - fixed_amount: notional = value
 *   - fixed_quantity: notional = value × currentPrice
 *   - lots: derive notional via notionalInUsd; margin via leverage divisor
 *   - risk_per_trade: derive lots from SL pct + capital + cross-rate
 *   - conviction_scaled: multiply base risk by convictionMultiplier (clamped ≥1)
 *   - slDistanceOverride takes precedence over rule-based slPct
 *   - leverage ≤ 0 falls back to default 30
 *   - lots ≤ 0 → null
 *   - notional > available → null (percentage/fixed)
 *   - marginRequired > available → null (lots/risk_per_trade)
 *   - quantity ≤ 0 → null
 *
 *  calculateRiskPrices:
 *   - long: SL = entry - slDelta, TP = entry + tpDelta
 *   - short: SL = entry + slDelta, TP = entry - tpDelta (mirrored)
 *   - slDistance override used when provided
 *   - tpDistance override used when provided
 *   - Falls back to priceDeltaForRule when overrides omitted
 *
 *  logActivity:
 *   - Inserts to activity_log with the expected payload shape
 *   - position_id defaults to null when omitted
 *   - ticker defaults to null when omitted
 *   - details defaults to {} when omitted
 *   - Error from supabase logged via logger.error (audit-write-safety)
 *   - Successful insert does NOT log to logger.error
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getContractSize,
  notionalInUsd,
  priceDeltaForRule,
  riskToLots,
  ruleAsPctOfEntry,
} from "@/lib/constants/markets";
import { logger } from "@/lib/logger";
import type { AlgorithmRules } from "@/types/algorithm";
import {
  calculatePositionSize,
  calculateRiskPrices,
  logActivity,
} from "./helpers";
import type { SupabaseClient } from "@supabase/supabase-js";

// ---- Mocks. -----------------------------------------------------------
vi.mock("@/lib/constants/markets", () => ({
  getContractSize: vi.fn(),
  notionalInUsd: vi.fn(),
  priceDeltaForRule: vi.fn(),
  riskToLots: vi.fn(),
  ruleAsPctOfEntry: vi.fn(),
}));
vi.mock("@/lib/logger", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const mockedGetContractSize = vi.mocked(getContractSize);
const mockedNotionalInUsd = vi.mocked(notionalInUsd);
const mockedPriceDeltaForRule = vi.mocked(priceDeltaForRule);
const mockedRiskToLots = vi.mocked(riskToLots);
const mockedRuleAsPctOfEntry = vi.mocked(ruleAsPctOfEntry);
const mockedLogger = vi.mocked(logger);

// ---- Supabase activity_log mock — single-table insert. ---------------
function makeSupabaseLogMock(opts: { error?: { message: string } | null } = {}): {
  supabase: SupabaseClient;
  fromMock: ReturnType<typeof vi.fn>;
  insertMock: ReturnType<typeof vi.fn>;
} {
  const insertMock = vi
    .fn()
    .mockResolvedValue({ data: null, error: opts.error ?? null });
  const fromMock = vi.fn().mockReturnValue({ insert: insertMock });
  const supabaseStub = Object.create(null) as Record<string, unknown>;
  supabaseStub.from = fromMock;
  return {
    supabase: supabaseStub as unknown as SupabaseClient,
    fromMock,
    insertMock,
  };
}

// ---- Fixture builders. ------------------------------------------------
function makeSizing(fields: Record<string, unknown>): AlgorithmRules["position_sizing"] {
  const stub = Object.create(null) as Record<string, unknown>;
  Object.assign(stub, fields);
  return stub as unknown as AlgorithmRules["position_sizing"];
}

function makeRules(opts: {
  sizing?: AlgorithmRules["position_sizing"];
  leverage?: number;
  assetClass?: string;
  stopLoss?: AlgorithmRules["stop_loss"];
  takeProfit?: AlgorithmRules["take_profit"];
} = {}): AlgorithmRules {
  const slStub = Object.create(null) as Record<string, unknown>;
  Object.assign(slStub, { type: "percentage", value: 1.5 });
  const tpStub = Object.create(null) as Record<string, unknown>;
  Object.assign(tpStub, { type: "percentage", value: 3 });
  return {
    timeframe: "4h",
    asset_class: opts.assetClass ?? "commodities",
    position_sizing:
      opts.sizing ?? makeSizing({ type: "percentage_of_capital", value: 5 }),
    leverage: opts.leverage,
    stop_loss: opts.stopLoss ?? (slStub as unknown as AlgorithmRules["stop_loss"]),
    take_profit: opts.takeProfit ?? (tpStub as unknown as AlgorithmRules["take_profit"]),
  } as unknown as AlgorithmRules;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Deterministic defaults for math helpers; tests override per case
  mockedGetContractSize.mockReturnValue(100); // gold contract = 100 oz
  mockedNotionalInUsd.mockReturnValue(300_000); // example notional
  mockedPriceDeltaForRule.mockReturnValue(10); // $10 SL distance
  mockedRiskToLots.mockReturnValue(0.5); // 0.5 lots
  mockedRuleAsPctOfEntry.mockReturnValue(1.5); // 1.5% SL distance
});

// ======================================================================
// calculatePositionSize
// ======================================================================

describe("calculatePositionSize — availability gate", () => {
  it("returns null when openPositionsValue equals capital (no margin left)", () => {
    const result = calculatePositionSize(makeRules(), 10_000, 10_000, 3000, "XAU/USD");
    expect(result).toBeNull();
  });

  it("returns null when openPositionsValue exceeds capital", () => {
    expect(calculatePositionSize(makeRules(), 10_000, 12_000, 3000, "XAU/USD")).toBeNull();
  });
});

describe("calculatePositionSize — percentage_of_capital sizing", () => {
  it("notional = capital × value/100, quantity = notional/currentPrice, margin = notional", () => {
    const r = calculatePositionSize(
      makeRules({ sizing: makeSizing({ type: "percentage_of_capital", value: 5 }) }),
      10_000,
      0,
      3000,
      "XAU/USD"
    );
    expect(r).toEqual({
      quantity: 500 / 3000, // notional 500 / price 3000
      notionalValue: 500,
      marginRequired: 500,
    });
  });

  it("returns null when notional > available", () => {
    const r = calculatePositionSize(
      makeRules({ sizing: makeSizing({ type: "percentage_of_capital", value: 50 }) }),
      10_000,
      6_000, // available = 4000
      3000,
      "XAU/USD"
    );
    expect(r).toBeNull(); // 50% of 10K = 5000 > 4000 available
  });
});

describe("calculatePositionSize — fixed_amount sizing", () => {
  it("notional = sizing.value; quantity = notional/currentPrice", () => {
    const r = calculatePositionSize(
      makeRules({ sizing: makeSizing({ type: "fixed_amount", value: 1500 }) }),
      10_000,
      0,
      3000,
      "XAU/USD"
    );
    expect(r).toEqual({
      quantity: 0.5,
      notionalValue: 1500,
      marginRequired: 1500,
    });
  });

  it("returns null when fixed_amount > available", () => {
    expect(
      calculatePositionSize(
        makeRules({ sizing: makeSizing({ type: "fixed_amount", value: 5000 }) }),
        10_000,
        7_000,
        3000,
        "XAU/USD"
      )
    ).toBeNull();
  });
});

describe("calculatePositionSize — fixed_quantity sizing", () => {
  it("quantity is the raw sizing.value; notional = quantity × currentPrice", () => {
    const r = calculatePositionSize(
      makeRules({ sizing: makeSizing({ type: "fixed_quantity", value: 0.1 }) }),
      10_000,
      0,
      3000,
      "XAU/USD"
    );
    expect(r).toEqual({
      quantity: 0.1,
      notionalValue: 300,
      marginRequired: 300,
    });
  });
});

describe("calculatePositionSize — lots sizing (leveraged)", () => {
  it("lots → notionalInUsd via mocked helper; marginRequired = notional / leverage", () => {
    mockedNotionalInUsd.mockReturnValue(100_000); // 1 lot gold @ 3000 ≈ 100k notional
    mockedGetContractSize.mockReturnValue(100); // 100 oz contract
    const r = calculatePositionSize(
      makeRules({
        sizing: makeSizing({ type: "lots", value: 1 }),
        leverage: 30,
      }),
      10_000,
      0,
      3000,
      "XAU/USD"
    );
    expect(r).not.toBeNull();
    // 1 lot × 100 oz = 100 quantity; notional 100k; margin 100k/30 ≈ 3333
    expect(r?.quantity).toBe(100);
    expect(r?.notionalValue).toBe(100_000);
    expect(r?.marginRequired).toBeCloseTo(3333.33, 2);
  });

  it("leverage ≤ 0 falls back to default 30 (defensive against bad config)", () => {
    mockedNotionalInUsd.mockReturnValue(100_000);
    const rZero = calculatePositionSize(
      makeRules({ sizing: makeSizing({ type: "lots", value: 1 }), leverage: 0 }),
      10_000,
      0,
      3000,
      "XAU/USD"
    );
    const rNeg = calculatePositionSize(
      makeRules({ sizing: makeSizing({ type: "lots", value: 1 }), leverage: -5 }),
      10_000,
      0,
      3000,
      "XAU/USD"
    );
    // Both should compute margin as notional / 30 (default fallback)
    expect(rZero?.marginRequired).toBeCloseTo(3333.33, 2);
    expect(rNeg?.marginRequired).toBeCloseTo(3333.33, 2);
  });

  it("lots ≤ 0 from sizing.value → null", () => {
    const r = calculatePositionSize(
      makeRules({ sizing: makeSizing({ type: "lots", value: 0 }) }),
      10_000,
      0,
      3000,
      "XAU/USD"
    );
    expect(r).toBeNull();
  });

  it("marginRequired > available → null", () => {
    mockedNotionalInUsd.mockReturnValue(1_000_000); // huge notional
    const r = calculatePositionSize(
      makeRules({ sizing: makeSizing({ type: "lots", value: 1 }), leverage: 30 }),
      10_000,
      0,
      3000,
      "XAU/USD"
    );
    // margin = 1_000_000 / 30 ≈ 33,333 > 10,000 → null
    expect(r).toBeNull();
  });
});

describe("calculatePositionSize — risk_per_trade sizing", () => {
  it("derives lots from riskToLots(symbol, capital, riskPct, currentPrice, slPct)", () => {
    mockedRuleAsPctOfEntry.mockReturnValue(1.5); // 1.5% SL distance
    mockedRiskToLots.mockReturnValue(0.5);
    mockedNotionalInUsd.mockReturnValue(150_000);

    const r = calculatePositionSize(
      makeRules({
        sizing: makeSizing({ type: "risk_per_trade", value: 1 }), // 1% capital risk
        leverage: 30,
      }),
      10_000,
      0,
      3000,
      "XAU/USD"
    );
    expect(mockedRiskToLots).toHaveBeenCalledWith("XAU/USD", 10_000, 1, 3000, 1.5);
    expect(r?.notionalValue).toBe(150_000);
    expect(r?.marginRequired).toBeCloseTo(5000, 0); // 150k/30
  });

  it("uses slDistanceOverride for slPct when provided (currentPrice > 0)", () => {
    const r = calculatePositionSize(
      makeRules({ sizing: makeSizing({ type: "risk_per_trade", value: 1 }) }),
      10_000,
      0,
      3000,
      "XAU/USD",
      1, // convictionMultiplier
      30 // slDistanceOverride: $30 SL distance
    );
    // slPct = 30/3000 × 100 = 1.0
    expect(mockedRiskToLots).toHaveBeenCalledWith("XAU/USD", 10_000, 1, 3000, 1);
    // ruleAsPctOfEntry should NOT be called when override is set
    expect(mockedRuleAsPctOfEntry).not.toHaveBeenCalled();
    expect(r).not.toBeNull();
  });

  it("falls back to ruleAsPctOfEntry when slDistanceOverride is omitted", () => {
    calculatePositionSize(
      makeRules({ sizing: makeSizing({ type: "risk_per_trade", value: 1 }) }),
      10_000,
      0,
      3000,
      "XAU/USD"
    );
    expect(mockedRuleAsPctOfEntry).toHaveBeenCalledOnce();
  });
});

describe("calculatePositionSize — conviction_scaled sizing", () => {
  it("multiplies base risk by convictionMultiplier (clamped ≥1)", () => {
    calculatePositionSize(
      makeRules({ sizing: makeSizing({ type: "conviction_scaled", value: 1 }) }),
      10_000,
      0,
      3000,
      "XAU/USD",
      2.5 // 2.5× multiplier
    );
    // effectiveRiskPct = 1 × 2.5 = 2.5
    expect(mockedRiskToLots).toHaveBeenCalledWith("XAU/USD", 10_000, 2.5, 3000, 1.5);
  });

  it("clamps multiplier to ≥ 1 (sub-1 multipliers would shrink risk below base)", () => {
    calculatePositionSize(
      makeRules({ sizing: makeSizing({ type: "conviction_scaled", value: 1 }) }),
      10_000,
      0,
      3000,
      "XAU/USD",
      0.5 // 0.5× — should clamp to 1
    );
    // Math.max(1, 0.5) = 1 → effectiveRiskPct = 1 × 1 = 1
    expect(mockedRiskToLots).toHaveBeenCalledWith("XAU/USD", 10_000, 1, 3000, 1.5);
  });
});

// ======================================================================
// calculateRiskPrices
// ======================================================================

describe("calculateRiskPrices — long side", () => {
  it("SL = entry - slDelta, TP = entry + tpDelta", () => {
    const r = calculateRiskPrices(3000, makeRules(), "long", "XAU/USD", 20, 60);
    expect(r).toEqual({
      stopLossPrice: 2980,
      takeProfitPrice: 3060,
    });
  });

  it("falls back to priceDeltaForRule when slDistance/tpDistance omitted", () => {
    mockedPriceDeltaForRule.mockReturnValueOnce(15).mockReturnValueOnce(45);
    const r = calculateRiskPrices(3000, makeRules(), "long", "XAU/USD");
    expect(mockedPriceDeltaForRule).toHaveBeenCalledTimes(2);
    expect(r).toEqual({
      stopLossPrice: 2985,
      takeProfitPrice: 3045,
    });
  });
});

describe("calculateRiskPrices — short side (mirrored)", () => {
  it("SL = entry + slDelta, TP = entry - tpDelta (mirrored from long)", () => {
    const r = calculateRiskPrices(3000, makeRules(), "short", "XAU/USD", 20, 60);
    expect(r).toEqual({
      stopLossPrice: 3020,
      takeProfitPrice: 2940,
    });
  });
});

describe("calculateRiskPrices — partial override", () => {
  it("slDistance override + tpDistance fallback (mixed paths)", () => {
    mockedPriceDeltaForRule.mockReturnValue(100); // TP fallback path
    const r = calculateRiskPrices(3000, makeRules(), "long", "XAU/USD", 25, undefined);
    // SL uses override (25), TP falls back to priceDeltaForRule (100)
    expect(r.stopLossPrice).toBe(2975);
    expect(r.takeProfitPrice).toBe(3100);
  });
});

// ======================================================================
// logActivity
// ======================================================================

describe("logActivity — successful insert", () => {
  it("inserts to activity_log with full payload when all fields provided", async () => {
    const { supabase, fromMock, insertMock } = makeSupabaseLogMock();
    await logActivity(supabase, "user-1", {
      algorithm_id: "algo-1",
      position_id: "pos-1",
      event_type: "signal_no_action",
      ticker: "XAU/USD",
      details: { reason: "test" },
    });
    expect(fromMock).toHaveBeenCalledWith("activity_log");
    expect(insertMock).toHaveBeenCalledWith({
      user_id: "user-1",
      algorithm_id: "algo-1",
      position_id: "pos-1",
      event_type: "signal_no_action",
      ticker: "XAU/USD",
      details: { reason: "test" },
    });
    expect(mockedLogger.error).not.toHaveBeenCalled();
  });

  it("position_id defaults to null when omitted", async () => {
    const { supabase, insertMock } = makeSupabaseLogMock();
    await logActivity(supabase, "user-1", {
      algorithm_id: "algo-1",
      event_type: "signal_no_action",
      ticker: "XAU/USD",
      details: { reason: "test" },
    });
    expect(insertMock.mock.calls[0][0].position_id).toBeNull();
  });

  it("ticker defaults to null when omitted", async () => {
    const { supabase, insertMock } = makeSupabaseLogMock();
    await logActivity(supabase, "user-1", {
      algorithm_id: "algo-1",
      event_type: "scan_started",
    });
    expect(insertMock.mock.calls[0][0].ticker).toBeNull();
  });

  it("details defaults to {} when omitted (NOT null — DB schema expects an object)", async () => {
    const { supabase, insertMock } = makeSupabaseLogMock();
    await logActivity(supabase, "user-1", {
      algorithm_id: "algo-1",
      event_type: "scan_started",
    });
    expect(insertMock.mock.calls[0][0].details).toEqual({});
  });

  it("algorithm_id: null (cron-level events) passes through to the insert", async () => {
    const { supabase, insertMock } = makeSupabaseLogMock();
    await logActivity(supabase, "user-1", {
      algorithm_id: null,
      event_type: "scan_completed",
    });
    expect(insertMock.mock.calls[0][0].algorithm_id).toBeNull();
  });
});

describe("logActivity — error surfacing (audit-write-safety)", () => {
  it("when supabase returns error, logger.error is called with the message", async () => {
    const { supabase } = makeSupabaseLogMock({
      error: { message: "CHECK constraint violation: event_type" },
    });
    await logActivity(supabase, "user-1", {
      algorithm_id: "algo-1",
      event_type: "rogue_event_type_not_in_check_constraint",
    });
    expect(mockedLogger.error).toHaveBeenCalledWith(
      "activity-log",
      "insert failed for event_type=rogue_event_type_not_in_check_constraint",
      "CHECK constraint violation: event_type"
    );
  });

  it("function still resolves (doesn't throw) even on supabase error — audit failure is non-fatal", async () => {
    const { supabase } = makeSupabaseLogMock({
      error: { message: "permission denied" },
    });
    // Should not throw — error is logged + function returns undefined
    await expect(
      logActivity(supabase, "user-1", {
        algorithm_id: "algo-1",
        event_type: "signal_no_action",
      })
    ).resolves.toBeUndefined();
  });
});
