/**
 * Unit tests for openPosition (CB.T1 pass 13, 2026-06-22).
 * Thirteenth test in `src/lib/scan/`. Central position-opening path —
 * integrates risk-pool halt + cohort attribution + sizing + SL/TP +
 * broker mirror.
 *
 * Coverage (~25 tests):
 *  - Sizing returns null → opened:0
 *  - DB insert returns null → opened:0
 *  - Side resolution (long / short / auto-fallback)
 *  - Leveraged vs non-leveraged openValue computation
 *  - SL/TP distance computed only with bars present
 *  - Risk-pool halt: SKIPPED on no broker, SKIPPED on null slDistance,
 *    fires on both-present + tripped → logged + opened:0
 *  - Cohort attribution: entry_hour_utc always set;
 *    position_in_range_pct + entry_zone when bars ≥ 20;
 *    premium/discount/equilibrium classification;
 *    NOT computed when bars < 20; clamp to [0,100]
 *  - Lot derivation for broker mirror per sizing type
 *  - logOpenAndMirror invoked; executeLiveEntry only when brokerCtx set
 *  - Successful return shape (opened:1, openEvent, paperPositionId)
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  computeSlDistance,
  computeTpDistance,
  takeProfitRuleForSide,
} from "@/lib/algorithm/structural-sl";
import { getContractSize, pnlInUsd } from "@/lib/constants/markets";
import type { AlgorithmRules } from "@/types/algorithm";
import type { PaperPosition } from "@/types/position";
import { snapshotCondition } from "./entry-conviction";
import { openPosition, type AlgoContext } from "./entry-open";
import {
  calculatePositionSize,
  calculateRiskPrices,
  logActivity,
} from "./helpers";
import { executeLiveEntry, type BrokerExecutionContext } from "./live-execution";
import { checkRiskPoolHalt } from "./risk-pool-halt";
import type { SupabaseClient } from "@supabase/supabase-js";

// ---- Mocks. -----------------------------------------------------------
vi.mock("@/lib/constants/markets", () => ({
  getContractSize: vi.fn(),
  pnlInUsd: vi.fn(),
}));
vi.mock("@/lib/algorithm/structural-sl", () => ({
  computeSlDistance: vi.fn(),
  computeTpDistance: vi.fn(),
  takeProfitRuleForSide: vi.fn(),
  // Re-export needed by the source (dailyAtrFromBars used elsewhere)
  dailyAtrFromBars: vi.fn(),
}));
vi.mock("./entry-conviction", () => ({
  snapshotCondition: vi.fn(),
}));
vi.mock("./helpers", () => ({
  calculatePositionSize: vi.fn(),
  calculateRiskPrices: vi.fn(),
  logActivity: vi.fn(),
}));
vi.mock("./live-execution", () => ({
  executeLiveEntry: vi.fn(),
}));
vi.mock("./risk-pool-halt", () => ({
  checkRiskPoolHalt: vi.fn(),
}));

const mockedComputeSlDistance = vi.mocked(computeSlDistance);
const mockedComputeTpDistance = vi.mocked(computeTpDistance);
const mockedTakeProfitRuleForSide = vi.mocked(takeProfitRuleForSide);
const mockedGetContractSize = vi.mocked(getContractSize);
const mockedPnlInUsd = vi.mocked(pnlInUsd);
const mockedSnapshotCondition = vi.mocked(snapshotCondition);
const mockedCalculatePositionSize = vi.mocked(calculatePositionSize);
const mockedCalculateRiskPrices = vi.mocked(calculateRiskPrices);
const mockedLogActivity = vi.mocked(logActivity);
const mockedExecuteLiveEntry = vi.mocked(executeLiveEntry);
const mockedCheckRiskPoolHalt = vi.mocked(checkRiskPoolHalt);

// ---- Supabase insert mock. --------------------------------------------
// Chain: .from("paper_positions").insert(payload).select("id").single()
// Terminal .single() awaits {data, error}.
function makeSupabaseInsertMock(opts: {
  insertedId?: string | null;
  error?: { message: string } | null;
} = {}): {
  supabase: SupabaseClient;
  fromMock: ReturnType<typeof vi.fn>;
  capturedInsertPayload: unknown;
} {
  let capturedPayload: unknown = null;
  // insertedId === undefined → default "pos-new"; null → explicit null
  // (simulates DB returning no row); string → use as id.
  let resolvedData: { id: string } | null;
  if (opts.insertedId === undefined) {
    resolvedData = { id: "pos-new" };
  } else if (opts.insertedId === null) {
    resolvedData = null;
  } else {
    resolvedData = { id: opts.insertedId };
  }
  const singleMock = vi.fn().mockImplementation(() =>
    Promise.resolve({
      data: resolvedData,
      error: opts.error ?? null,
    })
  );
  const selectMock = vi.fn().mockReturnValue({ single: singleMock });
  const insertMock = vi.fn().mockImplementation((payload: unknown) => {
    capturedPayload = payload;
    return { select: selectMock };
  });
  const fromMock = vi.fn().mockReturnValue({ insert: insertMock });
  const supabaseStub = Object.create(null) as Record<string, unknown>;
  supabaseStub.from = fromMock;
  return {
    supabase: supabaseStub as unknown as SupabaseClient,
    fromMock,
    get capturedInsertPayload() {
      return capturedPayload;
    },
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
  side?: "long" | "short" | "auto";
  leverage?: number;
  combinedRiskCapPct?: number;
} = {}): AlgorithmRules {
  return {
    timeframe: "4h",
    asset_class: "commodities",
    position_sizing:
      opts.sizing ?? makeSizing({ type: "percentage_of_capital", value: 5 }),
    side: opts.side,
    leverage: opts.leverage,
    prop_firm: opts.combinedRiskCapPct
      ? { combined_risk_cap_pct: opts.combinedRiskCapPct }
      : undefined,
    stop_loss: { type: "percentage", value: 1.5 },
    take_profit: { type: "percentage", value: 3 },
  } as unknown as AlgorithmRules;
}

function makeAlgo(rules: AlgorithmRules, capital = 10_000): AlgoContext {
  return { id: "algo-1", name: "T", description: "", rules, capital };
}

function makeBars(n: number): Array<{ date: string; open: number; high: number; low: number; close: number; volume: number }> {
  const bars: Array<{ date: string; open: number; high: number; low: number; close: number; volume: number }> = [];
  for (let i = 0; i < n; i++) {
    bars.push({
      date: `2026-06-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
      open: 3000,
      high: 3010,
      low: 2990,
      close: 3005,
      volume: 100,
    });
  }
  return bars;
}

// PaperPosition stub — function-call assertion exempt from the
// consistent-type-assertions rule. Used for partial PaperPosition rows
// (only notional_value is read by openPosition's openValue summation).
function makePosition(fields: Partial<PaperPosition>): PaperPosition {
  const stub = Object.create(null) as Record<string, unknown>;
  Object.assign(stub, fields);
  return stub as unknown as PaperPosition;
}

function makeBrokerCtx(connId: string | null = "broker-conn-1"): BrokerExecutionContext {
  const stub = Object.create(null) as Record<string, unknown>;
  stub.adapter = Object.create(null);
  stub.conn = connId === null ? null : { id: connId };
  return stub as unknown as BrokerExecutionContext;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default math mocks
  mockedComputeSlDistance.mockReturnValue(15);
  mockedComputeTpDistance.mockReturnValue(45);
  mockedTakeProfitRuleForSide.mockImplementation((rules) => rules.take_profit);
  mockedGetContractSize.mockReturnValue(100);
  mockedPnlInUsd.mockReturnValue(-150); // proposed-risk fallback
  mockedSnapshotCondition.mockImplementation((c) => c);
  mockedCalculatePositionSize.mockReturnValue({
    quantity: 0.1,
    notionalValue: 300,
    marginRequired: 300,
  });
  mockedCalculateRiskPrices.mockReturnValue({
    stopLossPrice: 2985,
    takeProfitPrice: 3045,
  });
  mockedLogActivity.mockResolvedValue(undefined);
  mockedExecuteLiveEntry.mockResolvedValue(undefined);
  mockedCheckRiskPoolHalt.mockResolvedValue({
    tripped: false,
    currentRiskPct: 0,
    proposedRiskPct: 0,
    combinedRiskPct: 0,
    capPct: 3,
  });
});

// ======================================================================
// Sizing + DB-insert short-circuits
// ======================================================================

describe("openPosition — short-circuit paths", () => {
  it("returns { opened: 0 } when calculatePositionSize returns null (insufficient margin)", async () => {
    mockedCalculatePositionSize.mockReturnValue(null);
    const { supabase, fromMock } = makeSupabaseInsertMock();
    const result = await openPosition({
      supabase,
      userId: "user-1",
      algo: makeAlgo(makeRules({ side: "long" })),
      ticker: "XAU/USD",
      currentPrice: 3000,
      conditions: [],
      sentimentResult: undefined,
      allOpenPositions: [],
      brokerCtx: null,
      bars: makeBars(20),
    });
    expect(result).toEqual({ opened: 0 });
    // No DB insert attempted when sizing rejects
    expect(fromMock).not.toHaveBeenCalled();
  });

  it("returns { opened: 0 } when DB insert returns null position", async () => {
    const { supabase } = makeSupabaseInsertMock({ insertedId: null });
    const result = await openPosition({
      supabase,
      userId: "user-1",
      algo: makeAlgo(makeRules({ side: "long" })),
      ticker: "XAU/USD",
      currentPrice: 3000,
      conditions: [],
      sentimentResult: undefined,
      allOpenPositions: [],
      brokerCtx: null,
      bars: makeBars(20),
    });
    expect(result).toEqual({ opened: 0 });
    // Broker mirror NOT called when DB row didn't materialise
    expect(mockedExecuteLiveEntry).not.toHaveBeenCalled();
  });
});

// ======================================================================
// Side resolution
// ======================================================================

describe("openPosition — side resolution", () => {
  it("rules.side='long' → DB insert uses long", async () => {
    const conf = makeSupabaseInsertMock();
    await openPosition({
      supabase: conf.supabase,
      userId: "user-1",
      algo: makeAlgo(makeRules({ side: "long" })),
      ticker: "XAU/USD",
      currentPrice: 3000,
      conditions: [],
      sentimentResult: undefined,
      allOpenPositions: [],
      brokerCtx: null,
      bars: makeBars(20),
    });
    expect((conf.capturedInsertPayload as { side: string }).side).toBe("long");
  });

  it("rules.side='short' → DB insert uses short", async () => {
    const conf = makeSupabaseInsertMock();
    await openPosition({
      supabase: conf.supabase,
      userId: "user-1",
      algo: makeAlgo(makeRules({ side: "short" })),
      ticker: "XAU/USD",
      currentPrice: 3000,
      conditions: [],
      sentimentResult: undefined,
      allOpenPositions: [],
      brokerCtx: null,
      bars: makeBars(20),
    });
    expect((conf.capturedInsertPayload as { side: string }).side).toBe("short");
  });

  it("rules.side='auto' (or any non-long/short) falls back to long for legacy callers", async () => {
    const conf = makeSupabaseInsertMock();
    await openPosition({
      supabase: conf.supabase,
      userId: "user-1",
      algo: makeAlgo(makeRules({ side: "auto" })),
      ticker: "XAU/USD",
      currentPrice: 3000,
      conditions: [],
      sentimentResult: undefined,
      allOpenPositions: [],
      brokerCtx: null,
      bars: makeBars(20),
    });
    expect((conf.capturedInsertPayload as { side: string }).side).toBe("long");
  });
});

// ======================================================================
// openValue computation (leveraged vs non-leveraged)
// ======================================================================

describe("openPosition — openValue computation", () => {
  it("leveraged sizing (lots/risk_per_trade/conviction_scaled) sums notional/leverage", async () => {
    mockedCalculatePositionSize.mockImplementation(
      (_rules, _capital, openValue) => {
        // Capture the openValue passed in for assertion
        capturedOpenValue = openValue;
        return { quantity: 0.1, notionalValue: 300, marginRequired: 300 };
      }
    );
    let capturedOpenValue = 0;
    const { supabase } = makeSupabaseInsertMock();
    const open1 = makePosition({ notional_value: 30_000 });
    const open2 = makePosition({ notional_value: 60_000 });
    await openPosition({
      supabase,
      userId: "user-1",
      algo: makeAlgo(
        makeRules({
          sizing: makeSizing({ type: "lots", value: 1 }),
          leverage: 30,
        })
      ),
      ticker: "XAU/USD",
      currentPrice: 3000,
      conditions: [],
      sentimentResult: undefined,
      allOpenPositions: [open1, open2],
      brokerCtx: null,
      bars: makeBars(20),
    });
    // openValue = (30_000 + 60_000) / 30 = 3000
    expect(capturedOpenValue).toBe(3000);
  });

  it("non-leveraged sizing (percentage_of_capital/fixed_amount) sums notional directly", async () => {
    let capturedOpenValue = 0;
    mockedCalculatePositionSize.mockImplementation((_r, _c, openValue) => {
      capturedOpenValue = openValue;
      return { quantity: 0.1, notionalValue: 300, marginRequired: 300 };
    });
    const { supabase } = makeSupabaseInsertMock();
    const open1 = makePosition({ notional_value: 500 });
    const open2 = makePosition({ notional_value: 800 });
    await openPosition({
      supabase,
      userId: "user-1",
      algo: makeAlgo(
        makeRules({ sizing: makeSizing({ type: "percentage_of_capital", value: 5 }) })
      ),
      ticker: "XAU/USD",
      currentPrice: 3000,
      conditions: [],
      sentimentResult: undefined,
      allOpenPositions: [open1, open2],
      brokerCtx: null,
      bars: makeBars(20),
    });
    expect(capturedOpenValue).toBe(1300); // raw sum
  });

  it("default leverage is 30 when rules.leverage is undefined", async () => {
    let capturedOpenValue = 0;
    mockedCalculatePositionSize.mockImplementation((_r, _c, openValue) => {
      capturedOpenValue = openValue;
      return { quantity: 0.1, notionalValue: 300, marginRequired: 300 };
    });
    const { supabase } = makeSupabaseInsertMock();
    await openPosition({
      supabase,
      userId: "user-1",
      algo: makeAlgo(
        makeRules({
          sizing: makeSizing({ type: "lots", value: 1 }),
          // leverage omitted
        })
      ),
      ticker: "XAU/USD",
      currentPrice: 3000,
      conditions: [],
      sentimentResult: undefined,
      allOpenPositions: [makePosition({ notional_value: 30_000 })],
      brokerCtx: null,
      bars: makeBars(20),
    });
    expect(capturedOpenValue).toBe(1000); // 30_000 / 30 default
  });
});

// ======================================================================
// Risk-pool halt integration
// ======================================================================

describe("openPosition — risk-pool halt integration", () => {
  it("SKIPS risk-pool check when brokerCtx is null (paper-only)", async () => {
    const { supabase } = makeSupabaseInsertMock();
    await openPosition({
      supabase,
      userId: "user-1",
      algo: makeAlgo(makeRules({ side: "long" })),
      ticker: "XAU/USD",
      currentPrice: 3000,
      conditions: [],
      sentimentResult: undefined,
      allOpenPositions: [],
      brokerCtx: null,
      bars: makeBars(20),
    });
    expect(mockedCheckRiskPoolHalt).not.toHaveBeenCalled();
  });

  it("SKIPS risk-pool check when slDistance is undefined (bars empty)", async () => {
    const { supabase } = makeSupabaseInsertMock();
    await openPosition({
      supabase,
      userId: "user-1",
      algo: makeAlgo(makeRules({ side: "long" })),
      ticker: "XAU/USD",
      currentPrice: 3000,
      conditions: [],
      sentimentResult: undefined,
      allOpenPositions: [],
      brokerCtx: makeBrokerCtx(), // broker present
      bars: undefined, // no bars → no slDistance
    });
    expect(mockedCheckRiskPoolHalt).not.toHaveBeenCalled();
  });

  it("blocks + logs when risk-pool halt trips", async () => {
    mockedCheckRiskPoolHalt.mockResolvedValue({
      tripped: true,
      currentRiskPct: 2.5,
      proposedRiskPct: 1.0,
      combinedRiskPct: 3.5,
      capPct: 3,
    });
    const { supabase, fromMock } = makeSupabaseInsertMock();
    const result = await openPosition({
      supabase,
      userId: "user-1",
      algo: makeAlgo(makeRules({ side: "long" })),
      ticker: "XAU/USD",
      currentPrice: 3000,
      conditions: [],
      sentimentResult: undefined,
      allOpenPositions: [],
      brokerCtx: makeBrokerCtx(),
      bars: makeBars(20),
    });
    expect(result).toEqual({ opened: 0 });
    expect(fromMock).not.toHaveBeenCalled(); // No DB insert when halt trips
    expect(mockedExecuteLiveEntry).not.toHaveBeenCalled();
    // Log payload includes the halt math + source marker
    const logCall = mockedLogActivity.mock.calls[0];
    expect(logCall[2].details).toMatchObject({
      reason: expect.stringContaining("Risk-pool halt"),
      source: "risk_pool_halt",
      current_risk_pct: 2.5,
      proposed_risk_pct: 1.0,
      combined_risk_pct: 3.5,
      cap_pct: 3,
    });
  });

  it("passes combined_risk_cap_pct from prop_firm rules through to checkRiskPoolHalt", async () => {
    const { supabase } = makeSupabaseInsertMock();
    await openPosition({
      supabase,
      userId: "user-1",
      algo: makeAlgo(makeRules({ side: "long", combinedRiskCapPct: 2.5 })),
      ticker: "XAU/USD",
      currentPrice: 3000,
      conditions: [],
      sentimentResult: undefined,
      allOpenPositions: [],
      brokerCtx: makeBrokerCtx(),
      bars: makeBars(20),
    });
    expect(mockedCheckRiskPoolHalt).toHaveBeenCalledWith(
      expect.anything(),
      "broker-conn-1",
      10_000,
      expect.any(Number),
      2.5 // cap override
    );
  });
});

// ======================================================================
// Cohort attribution
// ======================================================================

describe("openPosition — cohort attribution", () => {
  it("entry_hour_utc ALWAYS set (even with no bars / no caller cohort)", async () => {
    const conf = makeSupabaseInsertMock();
    await openPosition({
      supabase: conf.supabase,
      userId: "user-1",
      algo: makeAlgo(makeRules({ side: "long" })),
      ticker: "XAU/USD",
      currentPrice: 3000,
      conditions: [],
      sentimentResult: undefined,
      allOpenPositions: [],
      brokerCtx: null,
      bars: undefined,
    });
    const payload = conf.capturedInsertPayload as {
      entry_reason: { cohort?: { entry_hour_utc?: number } };
    };
    expect(payload.entry_reason.cohort?.entry_hour_utc).toEqual(expect.any(Number));
    // Must be a valid UTC hour
    expect(payload.entry_reason.cohort?.entry_hour_utc).toBeGreaterThanOrEqual(0);
    expect(payload.entry_reason.cohort?.entry_hour_utc).toBeLessThanOrEqual(23);
  });

  it("position_in_range_pct + entry_zone computed when bars ≥ 20", async () => {
    const conf = makeSupabaseInsertMock();
    // Build 20 bars with swingHigh=3010, swingLow=2990 (range = 20).
    // currentPrice=3005 → pct = (3005-2990)/20 × 100 = 75 → premium.
    await openPosition({
      supabase: conf.supabase,
      userId: "user-1",
      algo: makeAlgo(makeRules({ side: "long" })),
      ticker: "XAU/USD",
      currentPrice: 3005,
      conditions: [],
      sentimentResult: undefined,
      allOpenPositions: [],
      brokerCtx: null,
      bars: makeBars(20),
    });
    const cohort = (conf.capturedInsertPayload as {
      entry_reason: { cohort?: { position_in_range_pct?: number; entry_zone?: string } };
    }).entry_reason.cohort;
    expect(cohort?.position_in_range_pct).toBe(75);
    expect(cohort?.entry_zone).toBe("premium");
  });

  it("entry_zone = 'discount' when position_in_range_pct ≤ 40", async () => {
    const conf = makeSupabaseInsertMock();
    // pct = (2994-2990)/20×100 = 20 → discount
    await openPosition({
      supabase: conf.supabase,
      userId: "user-1",
      algo: makeAlgo(makeRules({ side: "long" })),
      ticker: "XAU/USD",
      currentPrice: 2994,
      conditions: [],
      sentimentResult: undefined,
      allOpenPositions: [],
      brokerCtx: null,
      bars: makeBars(20),
    });
    const cohort = (conf.capturedInsertPayload as {
      entry_reason: { cohort?: { position_in_range_pct?: number; entry_zone?: string } };
    }).entry_reason.cohort;
    expect(cohort?.position_in_range_pct).toBe(20);
    expect(cohort?.entry_zone).toBe("discount");
  });

  it("entry_zone = 'equilibrium' when position_in_range_pct in (40, 60)", async () => {
    const conf = makeSupabaseInsertMock();
    // pct = (3000-2990)/20×100 = 50 → equilibrium
    await openPosition({
      supabase: conf.supabase,
      userId: "user-1",
      algo: makeAlgo(makeRules({ side: "long" })),
      ticker: "XAU/USD",
      currentPrice: 3000,
      conditions: [],
      sentimentResult: undefined,
      allOpenPositions: [],
      brokerCtx: null,
      bars: makeBars(20),
    });
    const cohort = (conf.capturedInsertPayload as {
      entry_reason: { cohort?: { position_in_range_pct?: number; entry_zone?: string } };
    }).entry_reason.cohort;
    expect(cohort?.entry_zone).toBe("equilibrium");
  });

  it("position_in_range_pct CLAMPED to [0, 100] when currentPrice outside 20-bar range", async () => {
    const conf = makeSupabaseInsertMock();
    // Price way above swingHigh → pct would be > 100 without clamp
    await openPosition({
      supabase: conf.supabase,
      userId: "user-1",
      algo: makeAlgo(makeRules({ side: "long" })),
      ticker: "XAU/USD",
      currentPrice: 3100,
      conditions: [],
      sentimentResult: undefined,
      allOpenPositions: [],
      brokerCtx: null,
      bars: makeBars(20),
    });
    const cohort = (conf.capturedInsertPayload as {
      entry_reason: { cohort?: { position_in_range_pct?: number } };
    }).entry_reason.cohort;
    expect(cohort?.position_in_range_pct).toBe(100); // clamped
  });

  it("position_in_range_pct NOT computed when bars < 20", async () => {
    const conf = makeSupabaseInsertMock();
    await openPosition({
      supabase: conf.supabase,
      userId: "user-1",
      algo: makeAlgo(makeRules({ side: "long" })),
      ticker: "XAU/USD",
      currentPrice: 3000,
      conditions: [],
      sentimentResult: undefined,
      allOpenPositions: [],
      brokerCtx: null,
      bars: makeBars(15), // < 20 threshold
    });
    const cohort = (conf.capturedInsertPayload as {
      entry_reason: { cohort?: { position_in_range_pct?: number; entry_zone?: string } };
    }).entry_reason.cohort;
    expect(cohort?.position_in_range_pct).toBeUndefined();
    expect(cohort?.entry_zone).toBeUndefined();
    // entry_hour_utc still set
    expect((cohort as { entry_hour_utc?: number })?.entry_hour_utc).toEqual(expect.any(Number));
  });

  it("caller-provided cohort (e.g. LLM-trader regime) merges with locally-computed fields", async () => {
    const conf = makeSupabaseInsertMock();
    await openPosition({
      supabase: conf.supabase,
      userId: "user-1",
      algo: makeAlgo(makeRules({ side: "long" })),
      ticker: "XAU/USD",
      currentPrice: 3005,
      conditions: [],
      sentimentResult: undefined,
      allOpenPositions: [],
      brokerCtx: null,
      bars: makeBars(20),
      cohortFromCaller: { regime: "HH" },
    });
    const cohort = (conf.capturedInsertPayload as {
      entry_reason: { cohort?: { regime?: string; entry_hour_utc?: number; position_in_range_pct?: number } };
    }).entry_reason.cohort;
    expect(cohort?.regime).toBe("HH"); // caller-provided
    expect(cohort?.entry_hour_utc).toEqual(expect.any(Number)); // locally computed
    expect(cohort?.position_in_range_pct).toBe(75); // locally computed
  });
});

// ======================================================================
// Lot derivation for broker mirror
// ======================================================================

describe("openPosition — lot derivation for broker mirror", () => {
  it("lots sizing → lotSizing is the raw sizing.value", async () => {
    const { supabase } = makeSupabaseInsertMock();
    await openPosition({
      supabase,
      userId: "user-1",
      algo: makeAlgo(makeRules({ sizing: makeSizing({ type: "lots", value: 2 }) })),
      ticker: "XAU/USD",
      currentPrice: 3000,
      conditions: [],
      sentimentResult: undefined,
      allOpenPositions: [],
      brokerCtx: makeBrokerCtx(),
      bars: makeBars(20),
    });
    expect(mockedExecuteLiveEntry).toHaveBeenCalledOnce();
    expect(mockedExecuteLiveEntry.mock.calls[0][0].lots).toBe(2);
  });

  it("risk_per_trade sizing → lotSizing = sizing.quantity / contractSize", async () => {
    mockedCalculatePositionSize.mockReturnValue({
      quantity: 150,
      notionalValue: 450_000,
      marginRequired: 15_000,
    });
    mockedGetContractSize.mockReturnValue(100); // gold contract
    const { supabase } = makeSupabaseInsertMock();
    await openPosition({
      supabase,
      userId: "user-1",
      algo: makeAlgo(makeRules({ sizing: makeSizing({ type: "risk_per_trade", value: 1 }) })),
      ticker: "XAU/USD",
      currentPrice: 3000,
      conditions: [],
      sentimentResult: undefined,
      allOpenPositions: [],
      brokerCtx: makeBrokerCtx(),
      bars: makeBars(20),
    });
    expect(mockedExecuteLiveEntry.mock.calls[0][0].lots).toBe(1.5); // 150 / 100
  });

  it("percentage_of_capital sizing → lotSizing is undefined (no meaningful lot count)", async () => {
    const { supabase } = makeSupabaseInsertMock();
    await openPosition({
      supabase,
      userId: "user-1",
      algo: makeAlgo(
        makeRules({ sizing: makeSizing({ type: "percentage_of_capital", value: 5 }) })
      ),
      ticker: "XAU/USD",
      currentPrice: 3000,
      conditions: [],
      sentimentResult: undefined,
      allOpenPositions: [],
      brokerCtx: makeBrokerCtx(),
      bars: makeBars(20),
    });
    expect(mockedExecuteLiveEntry.mock.calls[0][0].lots).toBeUndefined();
  });

  it("contractSize ≤ 0 (degenerate) → lotSizing undefined for risk_per_trade (avoids div-by-zero)", async () => {
    mockedGetContractSize.mockReturnValue(0);
    const { supabase } = makeSupabaseInsertMock();
    await openPosition({
      supabase,
      userId: "user-1",
      algo: makeAlgo(makeRules({ sizing: makeSizing({ type: "risk_per_trade", value: 1 }) })),
      ticker: "XAU/USD",
      currentPrice: 3000,
      conditions: [],
      sentimentResult: undefined,
      allOpenPositions: [],
      brokerCtx: makeBrokerCtx(),
      bars: makeBars(20),
    });
    expect(mockedExecuteLiveEntry.mock.calls[0][0].lots).toBeUndefined();
  });
});

// ======================================================================
// Broker mirror + return shape
// ======================================================================

describe("openPosition — broker mirror + successful return", () => {
  it("executeLiveEntry called when brokerCtx provided", async () => {
    const { supabase } = makeSupabaseInsertMock();
    const brokerCtx = makeBrokerCtx();
    await openPosition({
      supabase,
      userId: "user-1",
      algo: makeAlgo(makeRules({ side: "long" })),
      ticker: "XAU/USD",
      currentPrice: 3000,
      conditions: [],
      sentimentResult: undefined,
      allOpenPositions: [],
      brokerCtx,
      bars: makeBars(20),
    });
    expect(mockedExecuteLiveEntry).toHaveBeenCalledOnce();
    expect(mockedExecuteLiveEntry.mock.calls[0][0]).toMatchObject({
      algorithmId: "algo-1",
      paperPositionId: "pos-new",
      ticker: "XAU/USD",
      side: "long",
      notionalUsd: 300,
      currentPrice: 3000,
      stopLossPrice: 2985,
      takeProfitPrice: 3045,
      ctx: brokerCtx,
      capital: 10_000,
    });
  });

  it("executeLiveEntry NOT called when brokerCtx is null (paper-only)", async () => {
    const { supabase } = makeSupabaseInsertMock();
    await openPosition({
      supabase,
      userId: "user-1",
      algo: makeAlgo(makeRules({ side: "long" })),
      ticker: "XAU/USD",
      currentPrice: 3000,
      conditions: [],
      sentimentResult: undefined,
      allOpenPositions: [],
      brokerCtx: null,
      bars: makeBars(20),
    });
    expect(mockedExecuteLiveEntry).not.toHaveBeenCalled();
  });

  it("successful return shape: { opened: 1, openEvent, paperPositionId }", async () => {
    const { supabase } = makeSupabaseInsertMock({ insertedId: "pos-xyz" });
    const result = await openPosition({
      supabase,
      userId: "user-1",
      algo: makeAlgo(makeRules({ side: "long" })),
      ticker: "XAU/USD",
      currentPrice: 3000,
      conditions: [],
      sentimentResult: undefined,
      allOpenPositions: [],
      brokerCtx: null,
      bars: makeBars(20),
    });
    expect(result).toEqual({
      opened: 1,
      openEvent: { ticker: "XAU/USD", reason: "entry_signal", pnl: 0, price: 3000 },
      paperPositionId: "pos-xyz",
    });
  });

  it("DB insert payload includes initial_stop_loss_price (write-once snapshot for R math)", async () => {
    const conf = makeSupabaseInsertMock();
    await openPosition({
      supabase: conf.supabase,
      userId: "user-1",
      algo: makeAlgo(makeRules({ side: "long" })),
      ticker: "XAU/USD",
      currentPrice: 3000,
      conditions: [],
      sentimentResult: undefined,
      allOpenPositions: [],
      brokerCtx: null,
      bars: makeBars(20),
    });
    const payload = conf.capturedInsertPayload as {
      stop_loss_price: number;
      initial_stop_loss_price: number;
    };
    // Both fields set to same value at entry; manage tick mutates
    // stop_loss_price on LLM move_be, but initial stays as the 1R anchor.
    expect(payload.stop_loss_price).toBe(2985);
    expect(payload.initial_stop_loss_price).toBe(2985);
  });
});
