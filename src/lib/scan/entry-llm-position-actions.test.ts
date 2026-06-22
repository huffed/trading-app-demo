/**
 * Unit tests for the LLM-trader in-position actions (CB.T1 pass 3,
 * 2026-06-22). Third test in `src/lib/scan/`. New territory vs the
 * pure-gate tests: supabase write-mock + broker-mirror call assertions.
 *
 * Coverage:
 *  executeLlmMoveBe (8 tests):
 *   - No-position no-op + log
 *   - Missing stop_loss_price no-op + log
 *   - Zero slDistance (legacy BE'd row) no-op + log
 *   - Sub-1R favorable (long + short) no-op + log
 *   - Success: long → DB writes stop_loss_price=entryPrice + success log
 *   - Success: short → same path with mirrored side
 *   - 1R math uses initial_stop_loss_price when present
 *   - 1R math falls back to stop_loss_price when initial is null
 *
 *  executeLlmExit (5 tests):
 *   - No-position no-op + log
 *   - Success with brokerCtx → DB close + executeLiveExit + position_closed log
 *   - Success without brokerCtx → DB close + NO executeLiveExit + log
 *   - Realized PnL computed via pnlInUsd
 *   - broker_position_id null when row.broker_position_id is undefined
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { pnlInUsd } from "@/lib/constants/markets";
import type { AlgorithmRules } from "@/types/algorithm";
import type { PaperPosition } from "@/types/position";
import { executeLlmExit, executeLlmMoveBe } from "./entry-llm-position-actions";
import { logActivity } from "./helpers";
import { executeLiveExit } from "./live-execution";
import type { LlmTraderEvaluation } from "./llm-trader";
import type { EntryContext } from "./entry";
import type { SupabaseClient } from "@supabase/supabase-js";

// ---- Mocks. -----------------------------------------------------------
vi.mock("@/lib/constants/markets", () => ({
  pnlInUsd: vi.fn(),
}));
vi.mock("./helpers", () => ({
  logActivity: vi.fn(),
}));
vi.mock("./live-execution", () => ({
  executeLiveExit: vi.fn(),
}));

const mockedPnlInUsd = vi.mocked(pnlInUsd);
const mockedLogActivity = vi.mocked(logActivity);
const mockedExecuteLiveExit = vi.mocked(executeLiveExit);

// ---- Supabase mock builder — captures .from(table).update(payload).eq(col, val). --
// Returns the fluent chain stubs so tests can assert against the captured
// calls. Each call to makeSupabaseMock() yields a fresh independent chain.
function makeSupabaseMock(): {
  supabase: SupabaseClient;
  fromMock: ReturnType<typeof vi.fn>;
  updateMock: ReturnType<typeof vi.fn>;
  eqMock: ReturnType<typeof vi.fn>;
} {
  const eqMock = vi.fn().mockResolvedValue({ error: null });
  const updateMock = vi.fn().mockReturnValue({ eq: eqMock });
  const fromMock = vi.fn().mockReturnValue({ update: updateMock });
  const supabaseStub = Object.create(null) as Record<string, unknown>;
  supabaseStub.from = fromMock;
  return {
    supabase: supabaseStub as unknown as SupabaseClient,
    fromMock,
    updateMock,
    eqMock,
  };
}

// ---- Fixture builders. ------------------------------------------------
function makeRules(): AlgorithmRules {
  return { timeframe: "4h" } as unknown as AlgorithmRules;
}

function makeCtx(opts: {
  supabase?: SupabaseClient;
  brokerCtx?: EntryContext["brokerCtx"];
} = {}): EntryContext {
  return {
    supabase: opts.supabase ?? (Object.create(null) as SupabaseClient),
    userId: "user-1",
    algo: { id: "algo-1", name: "T", description: "", rules: makeRules(), capital: 10_000 },
    ticker: "XAU/USD",
    bars: [],
    closes: [],
    allOpenPositions: [],
    livePrice: null,
    brokerCtx: opts.brokerCtx ?? null,
    dailyBars: null,
    dxyBars: null,
    intermarket: null,
    cappedReason: null,
    force: false,
  };
}

function makePosition(overrides: Partial<PaperPosition> = {}): PaperPosition {
  const stub = Object.create(null) as Record<string, unknown>;
  Object.assign(stub, {
    id: "pos-1",
    side: "long",
    entry_price: 3000,
    quantity: 1,
    stop_loss_price: 2990, // 10pt distance
    initial_stop_loss_price: 2990,
    take_profit_price: 3020,
    status: "open",
    broker_position_id: null,
    ...overrides,
  });
  return stub as unknown as PaperPosition;
}

const SAMPLE_DECISION = { confidence: 0.8, reasoning: "test" };
const SAMPLE_EVALUATION = { regime: "HH", decision: null } as unknown as LlmTraderEvaluation;

beforeEach(() => {
  vi.clearAllMocks();
  mockedPnlInUsd.mockReturnValue(50); // default realized P&L
  mockedLogActivity.mockResolvedValue(undefined);
  mockedExecuteLiveExit.mockResolvedValue(undefined);
});

// ======================================================================
// executeLlmMoveBe
// ======================================================================

describe("executeLlmMoveBe — defensive sub-paths", () => {
  it("no-op + log when currentPosition is null", async () => {
    const { supabase, fromMock } = makeSupabaseMock();
    const result = await executeLlmMoveBe(
      makeCtx({ supabase }),
      null,
      3010,
      SAMPLE_DECISION,
      SAMPLE_EVALUATION
    );
    expect(result).toEqual({ opened: 0 });
    expect(fromMock).not.toHaveBeenCalled(); // no DB write
    expect(mockedLogActivity).toHaveBeenCalledOnce();
    expect(mockedLogActivity.mock.calls[0][2].details).toMatchObject({
      reason: "LLM decision: move_be but no open position",
      source: "llm_trader",
    });
  });

  it("no-op + log when position has no stop_loss_price", async () => {
    const { supabase, fromMock } = makeSupabaseMock();
    const pos = makePosition({ stop_loss_price: null });
    const result = await executeLlmMoveBe(
      makeCtx({ supabase }),
      pos,
      3010,
      SAMPLE_DECISION,
      SAMPLE_EVALUATION
    );
    expect(result).toEqual({ opened: 0 });
    expect(fromMock).not.toHaveBeenCalled();
    expect(mockedLogActivity.mock.calls[0][2].details.reason).toContain(
      "no stop_loss_price set"
    );
    // position_id IS included for this branch (vs no-position branch which omits it)
    expect(mockedLogActivity.mock.calls[0][2].position_id).toBe("pos-1");
  });

  it("no-op + log when slDistance <= 0 (legacy BE'd row)", async () => {
    const { supabase, fromMock } = makeSupabaseMock();
    // entry_price == initial_stop_loss_price → slDistance = 0
    const pos = makePosition({
      entry_price: 3000,
      stop_loss_price: 3000,
      initial_stop_loss_price: 3000,
    });
    const result = await executeLlmMoveBe(
      makeCtx({ supabase }),
      pos,
      3010,
      SAMPLE_DECISION,
      SAMPLE_EVALUATION
    );
    expect(result).toEqual({ opened: 0 });
    expect(fromMock).not.toHaveBeenCalled();
    expect(mockedLogActivity.mock.calls[0][2].details.reason).toContain(
      "zero initial SL distance"
    );
  });

  it("no-op + log when sub-1R favorable (long)", async () => {
    const { supabase, fromMock } = makeSupabaseMock();
    // entry=3000, SL=2990, slDistance=10. +1R = 3010. currentPrice=3005 → +0.5R.
    const result = await executeLlmMoveBe(
      makeCtx({ supabase }),
      makePosition(),
      3005,
      SAMPLE_DECISION,
      SAMPLE_EVALUATION
    );
    expect(result).toEqual({ opened: 0 });
    expect(fromMock).not.toHaveBeenCalled();
    expect(mockedLogActivity.mock.calls[0][2].details.reason).toContain(
      "only +0.50R favorable"
    );
  });

  it("no-op + log when sub-1R favorable (short)", async () => {
    const { supabase, fromMock } = makeSupabaseMock();
    // entry=3000, SL=3010, slDistance=10. short +1R = 2990. currentPrice=2995 → +0.5R.
    const pos = makePosition({
      side: "short",
      entry_price: 3000,
      stop_loss_price: 3010,
      initial_stop_loss_price: 3010,
    });
    await executeLlmMoveBe(makeCtx({ supabase }), pos, 2995, SAMPLE_DECISION, SAMPLE_EVALUATION);
    expect(fromMock).not.toHaveBeenCalled();
    expect(mockedLogActivity.mock.calls[0][2].details.reason).toContain(
      "only +0.50R favorable"
    );
  });
});

describe("executeLlmMoveBe — success paths", () => {
  it("long: DB-update sets stop_loss_price=entryPrice + emits success log at exactly +1R", async () => {
    const { supabase, fromMock, updateMock, eqMock } = makeSupabaseMock();
    // entry=3000, SL=2990, slDist=10. currentPrice=3010 → +1.00R.
    await executeLlmMoveBe(makeCtx({ supabase }), makePosition(), 3010, SAMPLE_DECISION, SAMPLE_EVALUATION);
    // DB write went to paper_positions with the entry price
    expect(fromMock).toHaveBeenCalledWith("paper_positions");
    expect(updateMock).toHaveBeenCalledWith({ stop_loss_price: 3000 });
    expect(eqMock).toHaveBeenCalledWith("id", "pos-1");
    // Success log uses the move_sl_to_be action label
    const lastLog = mockedLogActivity.mock.calls[mockedLogActivity.mock.calls.length - 1];
    expect(lastLog[2].details).toMatchObject({
      action: "move_sl_to_be",
      old_stop_loss: 2990,
      new_stop_loss: 3000,
      current_pnl_r: 1,
      reason: expect.stringContaining("moved SL to break-even at +1.00R"),
    });
  });

  it("short: DB-update + success log mirrored side at >=+1R", async () => {
    const { supabase, updateMock } = makeSupabaseMock();
    // entry=3000, SL=3010, slDist=10. currentPrice=2980 → +2.0R short.
    const pos = makePosition({
      side: "short",
      entry_price: 3000,
      stop_loss_price: 3010,
      initial_stop_loss_price: 3010,
    });
    await executeLlmMoveBe(makeCtx({ supabase }), pos, 2980, SAMPLE_DECISION, SAMPLE_EVALUATION);
    expect(updateMock).toHaveBeenCalledWith({ stop_loss_price: 3000 });
    const lastLog = mockedLogActivity.mock.calls[mockedLogActivity.mock.calls.length - 1];
    expect(lastLog[2].details.current_pnl_r).toBe(2);
  });

  it("uses initial_stop_loss_price for slDistance when both fields differ (second BE move)", async () => {
    const { supabase, updateMock } = makeSupabaseMock();
    // initial_stop_loss_price=2990 (entry-time), stop_loss_price=3000 (already
    // moved BE once). 1R math must use INITIAL distance (10pt), not the
    // current SL distance (0pt → would div-by-zero). Test: at +1R from
    // initial (currentPrice=3010), success branch fires.
    const pos = makePosition({
      stop_loss_price: 3000, // already at entry from prior move_be
      initial_stop_loss_price: 2990,
    });
    await executeLlmMoveBe(makeCtx({ supabase }), pos, 3010, SAMPLE_DECISION, SAMPLE_EVALUATION);
    expect(updateMock).toHaveBeenCalledWith({ stop_loss_price: 3000 });
    // old_stop_loss reports the CURRENT stop_loss_price (3000), not initial
    const lastLog = mockedLogActivity.mock.calls[mockedLogActivity.mock.calls.length - 1];
    expect(lastLog[2].details.old_stop_loss).toBe(3000);
  });

  it("falls back to stop_loss_price for slDistance when initial_stop_loss_price is null (pre-migration legacy row)", async () => {
    const { supabase, updateMock } = makeSupabaseMock();
    // initial null → falls back to stop_loss_price=2990. slDist=10. +1R at 3010.
    const pos = makePosition({ initial_stop_loss_price: null, stop_loss_price: 2990 });
    await executeLlmMoveBe(makeCtx({ supabase }), pos, 3010, SAMPLE_DECISION, SAMPLE_EVALUATION);
    expect(updateMock).toHaveBeenCalledWith({ stop_loss_price: 3000 });
  });
});

// ======================================================================
// executeLlmExit
// ======================================================================

describe("executeLlmExit", () => {
  it("no-op + log when currentPosition is null (defensive — shouldn't happen)", async () => {
    const { supabase, fromMock } = makeSupabaseMock();
    const result = await executeLlmExit(
      makeCtx({ supabase }),
      null,
      3010,
      SAMPLE_DECISION,
      SAMPLE_EVALUATION
    );
    expect(result).toEqual({ opened: 0 });
    expect(fromMock).not.toHaveBeenCalled();
    expect(mockedExecuteLiveExit).not.toHaveBeenCalled();
    expect(mockedLogActivity.mock.calls[0][2].details).toMatchObject({
      reason: "LLM decision: exit but no open position",
    });
  });

  it("success WITHOUT brokerCtx: DB close + NO broker mirror + position_closed log", async () => {
    const { supabase, fromMock, updateMock, eqMock } = makeSupabaseMock();
    mockedPnlInUsd.mockReturnValue(75);
    const result = await executeLlmExit(
      makeCtx({ supabase, brokerCtx: null }),
      makePosition(),
      3010,
      SAMPLE_DECISION,
      SAMPLE_EVALUATION
    );
    expect(result).toEqual({ opened: 0 });
    // pnlInUsd called with the exit math args
    expect(mockedPnlInUsd).toHaveBeenCalledWith("XAU/USD", "long", 3000, 3010, 1);
    // DB close went to paper_positions
    expect(fromMock).toHaveBeenCalledWith("paper_positions");
    const updatePayload = updateMock.mock.calls[0][0];
    expect(updatePayload).toMatchObject({
      current_price: 3010,
      exit_price: 3010,
      unrealized_pnl: 0,
      realized_pnl: 75,
      exit_reason: "exit_signal",
      status: "closed",
    });
    // closed_at must be a valid ISO timestamp (set via toISOString)
    expect(typeof updatePayload.closed_at).toBe("string");
    expect(updatePayload.closed_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(eqMock).toHaveBeenCalledWith("id", "pos-1");
    // NO broker mirror without brokerCtx
    expect(mockedExecuteLiveExit).not.toHaveBeenCalled();
    // position_closed log (NOT signal_no_action) — the event_type is the
    // primary regression detector for "did we count this as a closed trade?"
    const closeLog = mockedLogActivity.mock.calls[0];
    expect(closeLog[2].event_type).toBe("position_closed");
    expect(closeLog[2].details).toMatchObject({
      reason: "LLM decision: exit",
      exit_price: 3010,
      realized_pnl: 75,
      exit_reason: "exit_signal",
    });
  });

  it("success WITH brokerCtx: DB close + executeLiveExit called with broker_position_id passthrough", async () => {
    const { supabase } = makeSupabaseMock();
    const brokerCtxStub = Object.create(null) as EntryContext["brokerCtx"];
    const pos = makePosition({ broker_position_id: "broker-xyz-99" });
    await executeLlmExit(
      makeCtx({ supabase, brokerCtx: brokerCtxStub }),
      pos,
      3010,
      SAMPLE_DECISION,
      SAMPLE_EVALUATION
    );
    expect(mockedExecuteLiveExit).toHaveBeenCalledOnce();
    const liveExitArgs = mockedExecuteLiveExit.mock.calls[0][0];
    expect(liveExitArgs).toMatchObject({
      algorithmId: "algo-1",
      paperPositionId: "pos-1",
      ticker: "XAU/USD",
      brokerPositionId: "broker-xyz-99",
      closePrice: 3010,
      ctx: brokerCtxStub,
    });
  });

  it("broker mirror receives null brokerPositionId when row.broker_position_id is undefined", async () => {
    const { supabase } = makeSupabaseMock();
    const brokerCtxStub = Object.create(null) as EntryContext["brokerCtx"];
    // Position WITHOUT broker_position_id (e.g. paper-only mirror added later)
    const stub = Object.create(null) as Record<string, unknown>;
    Object.assign(stub, {
      id: "pos-2",
      side: "long",
      entry_price: 3000,
      quantity: 1,
      stop_loss_price: 2990,
      // intentionally NO broker_position_id field
    });
    const pos = stub as unknown as PaperPosition;
    await executeLlmExit(
      makeCtx({ supabase, brokerCtx: brokerCtxStub }),
      pos,
      3010,
      SAMPLE_DECISION,
      SAMPLE_EVALUATION
    );
    const liveExitArgs = mockedExecuteLiveExit.mock.calls[0][0];
    expect(liveExitArgs.brokerPositionId).toBeNull();
  });

  it("realized P&L comes from pnlInUsd(ticker, side, entry, exit, quantity) verbatim", async () => {
    const { supabase, updateMock } = makeSupabaseMock();
    mockedPnlInUsd.mockReturnValue(-123.45);
    const pos = makePosition({ side: "short", entry_price: 3000, quantity: 2 });
    await executeLlmExit(makeCtx({ supabase }), pos, 3020, SAMPLE_DECISION, SAMPLE_EVALUATION);
    expect(mockedPnlInUsd).toHaveBeenCalledWith("XAU/USD", "short", 3000, 3020, 2);
    // Negative P&L flows through to the DB close payload
    expect(updateMock.mock.calls[0][0].realized_pnl).toBe(-123.45);
  });
});
