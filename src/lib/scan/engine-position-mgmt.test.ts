/**
 * Unit tests for engine-position-mgmt (CB.T1.7 pass 1, 2026-06-22 EVE LATE).
 *
 * Module manages per-position lifecycle on every scan/manage tick:
 *  1. Compute unrealizedPnl via pnlInUsd
 *  2. Run stagnant-exit gate (preempts SL hit on losers)
 *  3. Run regular exit-trigger (SL/TP/signal)
 *  4. Exit OR update unrealized_pnl
 *  5. Atomic claim → broker mirror → logActivity
 *
 * Critical: the atomic claim path is the only thing preventing double-close
 * on race between 5-min manage tick and 15-min scan tick. Lock the contract.
 *
 * Coverage (16 tests):
 *
 *  Stagnant-exit gate evaluation (4):
 *   - rules.stagnant_exit disabled → evaluateStagnantExit returns null,
 *     falls through to checkExitTrigger
 *   - Position has stop_loss_price → uses |entry - SL| as stopDistance
 *   - Position lacks stop_loss_price → falls back to priceDeltaForRule
 *   - Stagnant fires → exitCheck = "stagnant_exit" (E2.25.f canonical; overrides exit-trigger)
 *
 *  No-exit update path (3):
 *   - No exit triggered → updates current_price + unrealized_pnl with
 *     status="open" guard
 *   - livePrice null → falls back to closes[closes.length-1]
 *   - unrealizedPnl computed via pnlInUsd with currentPrice
 *
 *  Atomic claim + close path (4):
 *   - Successful claim → broker mirror + logActivity, returns {closed:1, ...}
 *   - Claim returns 0 rows (raced) → skips broker exit + logActivity, {closed:0}
 *   - Claim returns error → logger.error called, skips broker exit, {closed:0}
 *   - brokerCtx=null → skips executeLiveExit
 *
 *  Event-type mapping (3):
 *   - exit_reason=stop_loss → eventType=stop_loss_hit
 *   - exit_reason=take_profit → eventType=take_profit_hit
 *   - exit_reason=signal_exit (or anything else) → eventType=position_closed
 *
 *  Payload completeness (2):
 *   - stagnantResult present → details include stagnant_bars_open + max_bars + mfe_r + current_r
 *   - closeEvent shape: {ticker, reason, pnl, price}
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkStagnantExit, resolveEntryBarIndex } from "@/lib/algorithm/stagnant-exit";
import { pnlInUsd, priceDeltaForRule } from "@/lib/constants/markets";
import { logger } from "@/lib/logger";
import type { PriceBar } from "@/lib/market-data/types";
import type { AlgorithmRules } from "@/types/algorithm";
import type { PaperPosition } from "@/types/position";
import {
  manageExistingPosition,
  type AlgoForPositionMgmt,
} from "./engine-position-mgmt";
import { checkExitTrigger } from "./exit-trigger";
import { logActivity } from "./helpers";
import { executeLiveExit, type BrokerExecutionContext } from "./live-execution";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/algorithm/stagnant-exit", () => ({
  checkStagnantExit: vi.fn(),
  resolveEntryBarIndex: vi.fn().mockReturnValue(0),
}));
vi.mock("@/lib/constants/markets", () => ({
  pnlInUsd: vi.fn(),
  priceDeltaForRule: vi.fn(),
}));
vi.mock("@/lib/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("./exit-trigger", () => ({ checkExitTrigger: vi.fn() }));
vi.mock("./helpers", () => ({ logActivity: vi.fn() }));
vi.mock("./live-execution", () => ({ executeLiveExit: vi.fn() }));

const mockedCheckStagnant = vi.mocked(checkStagnantExit);
const mockedResolveEntry = vi.mocked(resolveEntryBarIndex);
const mockedPnl = vi.mocked(pnlInUsd);
const mockedPriceDelta = vi.mocked(priceDeltaForRule);
const mockedLogger = vi.mocked(logger);
const mockedExitTrigger = vi.mocked(checkExitTrigger);
const mockedLogActivity = vi.mocked(logActivity);
const mockedExecuteLiveExit = vi.mocked(executeLiveExit);

// ---- Supabase mock — handles paper_positions.update.eq().eq() chain
//      AND paper_positions.update.eq().eq().select() chain (claim path).
interface SupabaseMockBag {
  supabase: SupabaseClient;
  capturedUpdate: { payload: unknown; eqCalls: Array<[string, unknown]>; selected: boolean } | null;
}

function makeSupabaseMock(opts: { claimRows?: Array<{ id: string }> | null; claimError?: { message: string } | null } = {}): SupabaseMockBag {
  let capturedUpdate: SupabaseMockBag["capturedUpdate"] = null;

  const fromMock = vi.fn().mockImplementation((table: string) => {
    if (table !== "paper_positions") throw new Error(`Unexpected table: ${table}`);
    return {
      update: vi.fn().mockImplementation((payload: unknown) => {
        const upd = { payload, eqCalls: [] as Array<[string, unknown]>, selected: false };
        capturedUpdate = upd;
        const chain: Record<string, unknown> = {};
        chain.eq = vi.fn().mockImplementation((col: string, val: unknown) => {
          upd.eqCalls.push([col, val]);
          return chain;
        });
        chain.select = vi.fn().mockImplementation((_cols?: string) => {
          upd.selected = true;
          return Promise.resolve({
            data: opts.claimRows === undefined ? [{ id: "p1" }] : opts.claimRows,
            error: opts.claimError ?? null,
          });
        });
        // Thenable for the non-claim path (just await the .eq chain).
        chain.then = (onful?: (v: unknown) => unknown, onrej?: (e: unknown) => unknown) =>
          Promise.resolve({ data: null, error: null }).then(onful, onrej);
        return chain;
      }),
    };
  });

  const supabaseStub = Object.create(null) as Record<string, unknown>;
  supabaseStub.from = fromMock;
  return {
    supabase: supabaseStub as unknown as SupabaseClient,
    get capturedUpdate() {
      return capturedUpdate;
    },
  };
}

// ---- Fixtures. -------------------------------------------------------
function makeBars(n: number, startClose = 3000): PriceBar[] {
  return Array.from({ length: n }, (_, i) => ({
    date: `2026-06-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
    open: startClose + i,
    high: startClose + i + 5,
    low: startClose + i - 5,
    close: startClose + i,
    volume: 100,
  }));
}

function makePosition(overrides: Partial<PaperPosition> = {}): PaperPosition {
  return {
    id: "pos-1",
    user_id: "user-1",
    algorithm_id: "algo-1",
    ticker: "XAU/USD",
    side: "long",
    entry_price: 3000,
    stop_loss_price: 2990,
    take_profit_price: 3030,
    quantity: 1,
    status: "open",
    opened_at: "2026-06-20T00:00:00Z",
    current_price: 3000,
    unrealized_pnl: 0,
    realized_pnl: null,
    exit_reason: null,
    exit_price: null,
    closed_at: null,
    broker_position_id: null,
    ...overrides,
  } as PaperPosition;
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
    ...overrides,
  } as unknown as AlgorithmRules;
}

const algo: AlgoForPositionMgmt = { id: "algo-1", name: "Test", rules: makeRules() };

beforeEach(() => {
  vi.clearAllMocks();
  mockedPnl.mockReturnValue(50); // default $50 unrealized
  mockedPriceDelta.mockReturnValue(10);
  mockedCheckStagnant.mockReturnValue({ exit: false } as ReturnType<typeof checkStagnantExit>);
  mockedExitTrigger.mockReturnValue(null);
  mockedResolveEntry.mockReturnValue(0);
  mockedLogActivity.mockResolvedValue(undefined);
  mockedExecuteLiveExit.mockResolvedValue(undefined);
});

// ======================================================================
// Stagnant-exit gate evaluation
// ======================================================================

describe("manageExistingPosition — stagnant-exit gate", () => {
  it("rules.stagnant_exit disabled → checkStagnantExit NOT called, falls through to checkExitTrigger", async () => {
    const { supabase } = makeSupabaseMock();
    const a = { ...algo, rules: makeRules({ stagnant_exit: { enabled: false } } as unknown as Partial<AlgorithmRules>) };
    await manageExistingPosition(supabase, "user-1", a, "XAU/USD", makePosition(), makeBars(50), [3055], 3055, null, null);
    expect(mockedCheckStagnant).not.toHaveBeenCalled();
    expect(mockedExitTrigger).toHaveBeenCalled();
  });

  it("position has stop_loss_price → uses |entry - SL| as stopDistance", async () => {
    const { supabase } = makeSupabaseMock();
    const rules = makeRules({ stagnant_exit: { enabled: true } } as unknown as Partial<AlgorithmRules>);
    const a = { ...algo, rules };
    await manageExistingPosition(supabase, "user-1", a, "XAU/USD", makePosition({ entry_price: 3000, stop_loss_price: 2985 }), makeBars(50), [3055], 3055, null, null);
    expect(mockedCheckStagnant).toHaveBeenCalledWith(
      expect.objectContaining({ stopDistance: 15 }) // |3000 - 2985|
    );
    expect(mockedPriceDelta).not.toHaveBeenCalled();
  });

  it("position lacks stop_loss_price → falls back to priceDeltaForRule(stop_loss, entry, ticker)", async () => {
    const { supabase } = makeSupabaseMock();
    mockedPriceDelta.mockReturnValue(20);
    const rules = makeRules({ stagnant_exit: { enabled: true }, stop_loss: { type: "percentage", value: 1.5 } } as unknown as Partial<AlgorithmRules>);
    const a = { ...algo, rules };
    await manageExistingPosition(supabase, "user-1", a, "XAU/USD", makePosition({ stop_loss_price: null as unknown as number }), makeBars(50), [3055], 3055, null, null);
    expect(mockedPriceDelta).toHaveBeenCalledWith(rules.stop_loss, 3000, "XAU/USD");
    expect(mockedCheckStagnant).toHaveBeenCalledWith(expect.objectContaining({ stopDistance: 20 }));
  });

  it("stagnant fires → exitCheck='stagnant_exit' (E2.25.f canonical; overrides exit-trigger)", async () => {
    const conf = makeSupabaseMock();
    const { supabase } = conf;
    mockedCheckStagnant.mockReturnValue({
      exit: true,
      reason: "no excursion",
      bars_open: 12,
      max_bars_threshold: 10,
      mfe_r: 0.1,
      current_r: -0.5,
    } as ReturnType<typeof checkStagnantExit>);
    mockedExitTrigger.mockReturnValue("stop_loss"); // would have triggered, but stagnant wins
    const rules = makeRules({ stagnant_exit: { enabled: true } } as unknown as Partial<AlgorithmRules>);
    const a = { ...algo, rules };
    const r = await manageExistingPosition(supabase, "user-1", a, "XAU/USD", makePosition(), makeBars(50), [3055], 3055, null, null);
    expect(r.closed).toBe(1);
    expect((conf.capturedUpdate?.payload as { exit_reason: string }).exit_reason).toBe("stagnant_exit");
  });
});

// ======================================================================
// No-exit update path
// ======================================================================

describe("manageExistingPosition — no-exit update path", () => {
  it("no exit → updates current_price + unrealized_pnl with status='open' guard", async () => {
    const conf = makeSupabaseMock();
    const { supabase } = conf;
    mockedPnl.mockReturnValue(42);
    const r = await manageExistingPosition(supabase, "user-1", algo, "XAU/USD", makePosition(), makeBars(50), [3055], 3055, null, null);
    expect(r).toEqual({ closed: 0, updated: 1 });
    expect(conf.capturedUpdate?.payload).toEqual({ current_price: 3055, unrealized_pnl: 42 });
    expect(conf.capturedUpdate?.eqCalls).toEqual([
      ["id", "pos-1"],
      ["status", "open"],
    ]);
    expect(conf.capturedUpdate?.selected).toBe(false); // no .select() on the update path
  });

  it("livePrice null → falls back to closes[closes.length-1] for currentPrice", async () => {
    const conf = makeSupabaseMock();
    const { supabase } = conf;
    await manageExistingPosition(supabase, "user-1", algo, "XAU/USD", makePosition(), makeBars(50), [3010, 3020, 3033], null, null, null);
    expect((conf.capturedUpdate?.payload as { current_price: number }).current_price).toBe(3033); // last close
  });

  it("unrealizedPnl computed via pnlInUsd(ticker, side, entry, currentPrice, qty)", async () => {
    const { supabase } = makeSupabaseMock();
    await manageExistingPosition(supabase, "user-1", algo, "XAU/USD", makePosition({ side: "short", entry_price: 3000, quantity: 2 }), makeBars(50), [2990], 2990, null, null);
    expect(mockedPnl).toHaveBeenCalledWith("XAU/USD", "short", 3000, 2990, 2);
  });
});

// ======================================================================
// Atomic claim + close path
// ======================================================================

describe("manageExistingPosition — atomic claim + close path", () => {
  it("successful claim → broker mirror + activity log + returns closed:1", async () => {
    const conf = makeSupabaseMock({ claimRows: [{ id: "pos-1" }] });
    const { supabase } = conf;
    mockedExitTrigger.mockReturnValue("stop_loss");
    mockedPnl.mockReturnValue(-100);
    const brokerCtx = { adapter: {}, conn: {} } as unknown as BrokerExecutionContext;
    const r = await manageExistingPosition(supabase, "user-1", algo, "XAU/USD", makePosition(), makeBars(50), [2980], 2980, brokerCtx, null);
    expect(r).toEqual({
      closed: 1,
      updated: 0,
      closeEvent: { ticker: "XAU/USD", reason: "stop_loss", pnl: -100, price: 2980 },
    });
    expect((conf.capturedUpdate?.payload as { exit_reason: string; status: string; realized_pnl: number }).status).toBe("closed");
    expect((conf.capturedUpdate?.payload as { exit_reason: string; status: string; realized_pnl: number }).exit_reason).toBe("stop_loss");
    expect((conf.capturedUpdate?.payload as { exit_reason: string; status: string; realized_pnl: number }).realized_pnl).toBe(-100);
    expect(conf.capturedUpdate?.eqCalls).toEqual([
      ["id", "pos-1"],
      ["status", "open"],
    ]);
    expect(conf.capturedUpdate?.selected).toBe(true);
    expect(mockedExecuteLiveExit).toHaveBeenCalledTimes(1);
    expect(mockedLogActivity).toHaveBeenCalledTimes(1);
  });

  it("claim returns 0 rows (raced) → skips broker exit + logActivity, returns {closed:0, updated:0}", async () => {
    const { supabase } = makeSupabaseMock({ claimRows: [] }); // raced
    mockedExitTrigger.mockReturnValue("stop_loss");
    const brokerCtx = { adapter: {}, conn: {} } as unknown as BrokerExecutionContext;
    const r = await manageExistingPosition(supabase, "user-1", algo, "XAU/USD", makePosition(), makeBars(50), [2980], 2980, brokerCtx, null);
    expect(r).toEqual({ closed: 0, updated: 0 });
    expect(mockedExecuteLiveExit).not.toHaveBeenCalled();
    expect(mockedLogActivity).not.toHaveBeenCalled();
    expect(mockedLogger.warn).toHaveBeenCalledWith(
      "scan-engine",
      expect.stringContaining("already closed by a concurrent tick")
    );
  });

  it("claim returns error → logger.error + skips broker exit, {closed:0}", async () => {
    const { supabase } = makeSupabaseMock({ claimError: { message: "DB unreachable" } });
    mockedExitTrigger.mockReturnValue("take_profit");
    const brokerCtx = { adapter: {}, conn: {} } as unknown as BrokerExecutionContext;
    const r = await manageExistingPosition(supabase, "user-1", algo, "XAU/USD", makePosition(), makeBars(50), [3030], 3030, brokerCtx, null);
    expect(r).toEqual({ closed: 0, updated: 0 });
    expect(mockedExecuteLiveExit).not.toHaveBeenCalled();
    expect(mockedLogger.error).toHaveBeenCalledWith(
      "scan-engine",
      expect.stringContaining("close update failed"),
      "DB unreachable"
    );
  });

  it("brokerCtx=null → executeLiveExit NOT called (paper-only close)", async () => {
    const { supabase } = makeSupabaseMock();
    mockedExitTrigger.mockReturnValue("take_profit");
    await manageExistingPosition(supabase, "user-1", algo, "XAU/USD", makePosition(), makeBars(50), [3030], 3030, null, null);
    expect(mockedExecuteLiveExit).not.toHaveBeenCalled();
    expect(mockedLogActivity).toHaveBeenCalled(); // log still fires
  });
});

// ======================================================================
// Event-type mapping (exit_reason → activity_log event_type)
// ======================================================================

describe("manageExistingPosition — event_type mapping", () => {
  it("exit_reason=stop_loss → event_type=stop_loss_hit", async () => {
    const { supabase } = makeSupabaseMock();
    mockedExitTrigger.mockReturnValue("stop_loss");
    await manageExistingPosition(supabase, "user-1", algo, "XAU/USD", makePosition(), makeBars(50), [2980], 2980, null, null);
    expect(mockedLogActivity.mock.calls[0][2]).toMatchObject({ event_type: "stop_loss_hit" });
  });

  it("exit_reason=take_profit → event_type=take_profit_hit", async () => {
    const { supabase } = makeSupabaseMock();
    mockedExitTrigger.mockReturnValue("take_profit");
    await manageExistingPosition(supabase, "user-1", algo, "XAU/USD", makePosition(), makeBars(50), [3030], 3030, null, null);
    expect(mockedLogActivity.mock.calls[0][2]).toMatchObject({ event_type: "take_profit_hit" });
  });

  it("exit_reason=signal_exit (anything else) → event_type=position_closed", async () => {
    const { supabase } = makeSupabaseMock();
    mockedExitTrigger.mockReturnValue("signal_exit");
    await manageExistingPosition(supabase, "user-1", algo, "XAU/USD", makePosition(), makeBars(50), [3010], 3010, null, null);
    expect(mockedLogActivity.mock.calls[0][2]).toMatchObject({ event_type: "position_closed" });
  });
});

// ======================================================================
// Payload completeness
// ======================================================================

describe("manageExistingPosition — payload completeness", () => {
  it("stagnantResult present → details include stagnant_bars_open + max_bars + mfe_r + current_r", async () => {
    const { supabase } = makeSupabaseMock();
    mockedCheckStagnant.mockReturnValue({
      exit: true,
      reason: "no excursion",
      bars_open: 12,
      max_bars_threshold: 10,
      mfe_r: 0.15,
      current_r: -0.5,
    } as ReturnType<typeof checkStagnantExit>);
    const rules = makeRules({ stagnant_exit: { enabled: true } } as unknown as Partial<AlgorithmRules>);
    const a = { ...algo, rules };
    await manageExistingPosition(supabase, "user-1", a, "XAU/USD", makePosition(), makeBars(50), [3010], 3010, null, null);
    expect(mockedLogActivity.mock.calls[0][2]).toMatchObject({
      details: expect.objectContaining({
        stagnant_bars_open: 12,
        stagnant_max_bars: 10,
        stagnant_mfe_r: 0.15,
        stagnant_current_r: -0.5,
      }),
    });
  });

  it("closeEvent shape: {ticker, reason, pnl, price}", async () => {
    const { supabase } = makeSupabaseMock();
    mockedExitTrigger.mockReturnValue("take_profit");
    mockedPnl.mockReturnValue(250);
    const r = await manageExistingPosition(supabase, "user-1", algo, "EUR/USD", makePosition({ ticker: "EUR/USD" }), makeBars(50), [1.1023], 1.1023, null, null);
    expect(r.closeEvent).toEqual({
      ticker: "EUR/USD",
      reason: "take_profit",
      pnl: 250,
      price: 1.1023,
    });
  });
});
