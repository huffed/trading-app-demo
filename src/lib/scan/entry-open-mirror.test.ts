/**
 * CB.T1 Tier 2 pass 2 — entry-open-mirror.ts (2026-06-22 NIGHT LATE).
 *
 * Post-insert broker-mirror + audit + lot derivation helpers extracted
 * from `entry-open.ts` (CB.H1 pass 12). Tests verify:
 *
 *  - deriveLotSizingForMirror: per-sizing-type contract
 *      - "lots" → returns rule.value verbatim
 *      - "risk_per_trade" / "conviction_scaled" → quantity / contract_size
 *      - degenerate contract size (0) → undefined
 *      - unknown sizing type → undefined
 *
 *  - logOpenAndMirror: audit-log + conditional broker mirror branches
 *      - Always emits `position_opened` activity_log with full payload
 *      - brokerCtx=null → executeLiveEntry NOT called (paper-only)
 *      - brokerCtx present → executeLiveEntry called with all args passed through
 *      - lots threaded when provided (JPY-cross-safe lot count)
 *      - divergenceRule threaded
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getContractSize } from "@/lib/constants/markets";
import type { AlgorithmRules } from "@/types/algorithm";
import { deriveLotSizingForMirror, logOpenAndMirror } from "./entry-open-mirror";
import { logActivity } from "./helpers";
import { executeLiveEntry, type BrokerExecutionContext } from "./live-execution";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/constants/markets", () => ({
  getContractSize: vi.fn(),
}));
vi.mock("./helpers", () => ({
  logActivity: vi.fn(),
}));
vi.mock("./live-execution", () => ({
  executeLiveEntry: vi.fn(),
}));

const mockedGetContract = vi.mocked(getContractSize);
const mockedLogActivity = vi.mocked(logActivity);
const mockedExecuteLiveEntry = vi.mocked(executeLiveEntry);

function makeRules(sizingType: AlgorithmRules["position_sizing"]["type"], value: number): AlgorithmRules {
  return {
    timeframe: "4h",
    asset_class: "forex",
    side: "long",
    max_positions: 1,
    position_sizing: { type: sizingType, value },
    stop_loss: { type: "percentage", value: 1 },
    take_profit: { type: "percentage", value: 2 },
    entry_conditions: [],
    exit_conditions: [],
  } as unknown as AlgorithmRules;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedGetContract.mockReturnValue(100_000); // forex default
  mockedLogActivity.mockResolvedValue(undefined);
  mockedExecuteLiveEntry.mockResolvedValue(undefined);
});

// ======================================================================
// deriveLotSizingForMirror
// ======================================================================

describe("deriveLotSizingForMirror", () => {
  it("'lots' sizing type → returns rule.value verbatim (regardless of sizedQuantity)", () => {
    const rules = makeRules("lots", 0.3);
    expect(deriveLotSizingForMirror(rules, "EUR/USD", 99_999)).toBe(0.3);
    expect(mockedGetContract).not.toHaveBeenCalled();
  });

  it("'risk_per_trade' → quantity / contract_size", () => {
    const rules = makeRules("risk_per_trade", 1);
    // sizedQuantity=200_000 / contract=100_000 → 2 lots
    expect(deriveLotSizingForMirror(rules, "EUR/USD", 200_000)).toBe(2);
    expect(mockedGetContract).toHaveBeenCalledWith("EUR/USD", "forex");
  });

  it("'conviction_scaled' → quantity / contract_size (same math as risk_per_trade)", () => {
    const rules = makeRules("conviction_scaled", 1);
    expect(deriveLotSizingForMirror(rules, "EUR/USD", 50_000)).toBe(0.5);
  });

  it("contract size 0 → undefined (div-by-zero guard)", () => {
    mockedGetContract.mockReturnValue(0);
    const rules = makeRules("risk_per_trade", 1);
    expect(deriveLotSizingForMirror(rules, "XAU/USD", 100_000)).toBeUndefined();
  });

  it("unknown sizing type → undefined", () => {
    const rules = makeRules("notional" as AlgorithmRules["position_sizing"]["type"], 10000);
    expect(deriveLotSizingForMirror(rules, "EUR/USD", 100_000)).toBeUndefined();
  });
});

// ======================================================================
// logOpenAndMirror
// ======================================================================

const supabaseStub = Object.create(null) as Record<string, unknown>;
supabaseStub.from = vi.fn();
const supabase = supabaseStub as unknown as SupabaseClient;

const baseArgs = {
  supabase,
  userId: "user-1",
  algoId: "algo-1",
  algoCapital: 10_000,
  paperPositionId: "pos-1",
  ticker: "EUR/USD",
  side: "long" as const,
  sizing: { quantity: 200_000, notionalValue: 200_000 },
  currentPrice: 1.0850,
  stopLossPrice: 1.0750,
  takeProfitPrice: 1.0950,
};

describe("logOpenAndMirror — audit log", () => {
  it("emits position_opened activity_log with full payload (always)", async () => {
    await logOpenAndMirror({ ...baseArgs, brokerCtx: null });
    expect(mockedLogActivity).toHaveBeenCalledTimes(1);
    expect(mockedLogActivity.mock.calls[0][1]).toBe("user-1");
    expect(mockedLogActivity.mock.calls[0][2]).toMatchObject({
      algorithm_id: "algo-1",
      position_id: "pos-1",
      event_type: "position_opened",
      ticker: "EUR/USD",
      details: {
        entry_price: 1.0850,
        quantity: 200_000,
        notional_value: 200_000,
        stop_loss_price: 1.0750,
        take_profit_price: 1.0950,
      },
    });
  });
});

describe("logOpenAndMirror — broker mirror branch", () => {
  it("brokerCtx=null → executeLiveEntry NOT called (paper-only)", async () => {
    await logOpenAndMirror({ ...baseArgs, brokerCtx: null });
    expect(mockedExecuteLiveEntry).not.toHaveBeenCalled();
  });

  it("brokerCtx present → executeLiveEntry called with full args passed through", async () => {
    const ctx = { adapter: {}, conn: { id: "broker-1" } } as unknown as BrokerExecutionContext;
    await logOpenAndMirror({ ...baseArgs, brokerCtx: ctx });
    expect(mockedExecuteLiveEntry).toHaveBeenCalledTimes(1);
    expect(mockedExecuteLiveEntry).toHaveBeenCalledWith({
      supabase,
      userId: "user-1",
      algorithmId: "algo-1",
      paperPositionId: "pos-1",
      ticker: "EUR/USD",
      side: "long",
      notionalUsd: 200_000,
      currentPrice: 1.0850,
      stopLossPrice: 1.0750,
      takeProfitPrice: 1.0950,
      ctx,
      capital: 10_000,
      lots: undefined,
      divergenceRule: undefined,
    });
  });

  it("lots threaded when provided (JPY-cross-safe lot count)", async () => {
    const ctx = { adapter: {}, conn: {} } as unknown as BrokerExecutionContext;
    await logOpenAndMirror({ ...baseArgs, brokerCtx: ctx, lots: 0.15 });
    expect((mockedExecuteLiveEntry.mock.calls[0][0]).lots).toBe(0.15);
  });

  it("divergenceRule threaded into executeLiveEntry", async () => {
    const ctx = { adapter: {}, conn: {} } as unknown as BrokerExecutionContext;
    const rule = { max_avg_bps: 5, window_trades: 10 };
    await logOpenAndMirror({ ...baseArgs, brokerCtx: ctx, divergenceRule: rule });
    expect((mockedExecuteLiveEntry.mock.calls[0][0]).divergenceRule).toEqual(rule);
  });

  it("audit log fires BEFORE broker mirror (ordering preserved)", async () => {
    const ctx = { adapter: {}, conn: {} } as unknown as BrokerExecutionContext;
    const callOrder: string[] = [];
    mockedLogActivity.mockImplementation(async () => {
      callOrder.push("logActivity");
    });
    mockedExecuteLiveEntry.mockImplementation(async () => {
      callOrder.push("executeLiveEntry");
    });
    await logOpenAndMirror({ ...baseArgs, brokerCtx: ctx });
    expect(callOrder).toEqual(["logActivity", "executeLiveEntry"]);
  });
});
