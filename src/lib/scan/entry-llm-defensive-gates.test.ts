/**
 * Unit tests for the LLM-trader defensive pre-gates (CB.T1 starter,
 * 2026-06-22). First test in `src/lib/scan/` — CB.T1 was filed because
 * the entire scan/ tree had 0 unit tests, and the cluster of newly-
 * extracted entry-* files (post CB.C1 + CB.H1) are now the ideal seam.
 *
 * Strategy: mock the 6 external dependencies (parseBarDate, checkNewsVeto,
 * checkConsecutiveLossHalt, checkReEntryCooldown, checkConsistencyHalt,
 * logActivity) and exercise each gate's blocked + fall-through paths plus
 * the ladder order (ATR fires before news, etc).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { checkAtrLiquidity } from "@/lib/algorithm/intraday-atr-gate";
import { checkReEntryCooldown } from "@/lib/algorithm/re-entry-cooldown";
import { parseBarDate } from "@/lib/market-data/parse-bar-date";
import type { AlgorithmRules } from "@/types/algorithm";
import type { PaperPosition } from "@/types/position";
import { checkConsecutiveLossHalt } from "./consec-loss-halt";
import { checkConsistencyHalt } from "./consistency-halt";
import { checkNewsVeto } from "./entry-gates";
import { checkDefensiveLlmGates } from "./entry-llm-defensive-gates";
import { logActivity } from "./helpers";
import type { EntryContext } from "./entry";
import type { SupabaseClient } from "@supabase/supabase-js";

// ---- Mock all external dependencies the gate cluster calls. -----------
// vi.mock() is hoisted to the top of the file by vitest at runtime, so
// it doesn't matter that this block appears after the imports — the
// mocks are still in effect when the imports resolve.
vi.mock("@/lib/algorithm/re-entry-cooldown", () => ({
  checkReEntryCooldown: vi.fn(),
}));
vi.mock("@/lib/market-data/parse-bar-date", () => ({
  parseBarDate: vi.fn(),
}));
vi.mock("./consec-loss-halt", () => ({
  checkConsecutiveLossHalt: vi.fn(),
}));
vi.mock("./consistency-halt", () => ({
  checkConsistencyHalt: vi.fn(),
}));
vi.mock("./entry-gates", () => ({
  checkNewsVeto: vi.fn(),
}));
vi.mock("./helpers", () => ({
  logActivity: vi.fn(),
}));

const mockedParseBarDate = vi.mocked(parseBarDate);
const mockedCheckNewsVeto = vi.mocked(checkNewsVeto);
const mockedCheckConsecLossHalt = vi.mocked(checkConsecutiveLossHalt);
const mockedCheckReEntryCooldown = vi.mocked(checkReEntryCooldown);
const mockedCheckConsistencyHalt = vi.mocked(checkConsistencyHalt);
const mockedLogActivity = vi.mocked(logActivity);

// ---- Fixture builders. ------------------------------------------------

function makeLiquidity(skip = false): ReturnType<typeof checkAtrLiquidity> {
  return skip
    ? { skip: true, reason: "ATR p20 floor", atr_current: 5, atr_threshold: 10 }
    : { skip: false, reason: undefined, atr_current: 15, atr_threshold: 10 };
}

function makeRules(overrides: Partial<AlgorithmRules["prop_firm"]> = {}): AlgorithmRules {
  // Minimal rule shape — only the fields the gates read. Cast at the
  // boundary; the gate function doesn't touch the other AlgorithmRules
  // fields and writing them all out here would be 100+ lines of noise.
  return {
    timeframe: "4h",
    prop_firm: { ...overrides },
  } as unknown as AlgorithmRules;
}

function makeCtx(opts: {
  rules?: AlgorithmRules;
  brokerCtx?: EntryContext["brokerCtx"];
} = {}): EntryContext {
  // Empty supabase stub — gate function never invokes any client method
  // on it; only passes it through to mocked dependencies. Test fixture
  // exemption to consistent-type-assertions justified.
  const supabaseStub = Object.create(null) as SupabaseClient;
  return {
    supabase: supabaseStub,
    userId: "user-1",
    algo: {
      id: "algo-1",
      name: "Test Algo",
      description: "",
      rules: opts.rules ?? makeRules(),
      capital: 10_000,
    },
    ticker: "XAU/USD",
    bars: [
      {
        date: "2026-06-22T10:00:00Z",
        open: 3000,
        high: 3010,
        low: 2990,
        close: 3005,
        volume: 100,
      },
    ],
    closes: [3005],
    allOpenPositions: [] as PaperPosition[],
    livePrice: 3005,
    brokerCtx: opts.brokerCtx ?? null,
    dailyBars: null,
    dxyBars: null,
    intermarket: null,
    cappedReason: null,
    force: false,
  };
}

// Default-passing mock responses for the test setup.
beforeEach(() => {
  vi.clearAllMocks();
  mockedParseBarDate.mockReturnValue(new Date("2026-06-22T10:00:00Z"));
  mockedCheckNewsVeto.mockResolvedValue({ vetoed: false });
  mockedCheckConsecLossHalt.mockResolvedValue({
    tripped: false,
    streak: 0,
    threshold: 3,
  });
  mockedCheckReEntryCooldown.mockResolvedValue({ block: false });
  mockedCheckConsistencyHalt.mockResolvedValue({
    tripped: false,
    today_net: 0,
    total_net: 1000,
    ratio: 0,
    threshold: 0.4,
  });
  mockedLogActivity.mockResolvedValue(undefined);
});

// ---- Test cases. ------------------------------------------------------

describe("checkDefensiveLlmGates", () => {
  it("falls through to { blocked: false } when every gate passes", async () => {
    const result = await checkDefensiveLlmGates(makeCtx(), makeLiquidity(false));
    expect(result).toEqual({ blocked: false });
    expect(mockedLogActivity).not.toHaveBeenCalled();
  });

  it("dead-hour gate blocks at 18 UTC and 19 UTC", async () => {
    for (const hour of [18, 19]) {
      vi.clearAllMocks();
      mockedParseBarDate.mockReturnValue(new Date(`2026-06-22T${hour}:00:00Z`));
      const result = await checkDefensiveLlmGates(makeCtx(), makeLiquidity(false));
      expect(result).toEqual({ blocked: true });
      expect(mockedLogActivity).toHaveBeenCalledOnce();
      // Verify the reason string contains the operator-grep marker
      // "Dead-hour gate" — regression-detector for any rewording.
      const logCall = mockedLogActivity.mock.calls[0];
      expect(logCall[2].details).toMatchObject({
        reason: expect.stringContaining("Dead-hour gate"),
        source: "llm_trader",
        utc_hour: hour,
      });
    }
  });

  it("dead-hour gate does NOT block at 10/12/17/20 UTC", async () => {
    for (const hour of [10, 12, 17, 20]) {
      mockedParseBarDate.mockReturnValue(new Date(`2026-06-22T${hour}:00:00Z`));
      const result = await checkDefensiveLlmGates(makeCtx(), makeLiquidity(false));
      expect(result).toEqual({ blocked: false });
    }
  });

  it("ATR liquidity gate blocks when liquidity.skip is true", async () => {
    const result = await checkDefensiveLlmGates(makeCtx(), makeLiquidity(true));
    expect(result).toEqual({ blocked: true });
    const logCall = mockedLogActivity.mock.calls[0];
    expect(logCall[2].details).toMatchObject({
      reason: "ATR p20 floor",
      source: "llm_trader",
      atr_current: 5,
      atr_threshold: 10,
    });
  });

  it("news veto blocks when checkNewsVeto returns vetoed", async () => {
    mockedCheckNewsVeto.mockResolvedValue({ vetoed: true, reason: "FOMC tier-1" });
    const result = await checkDefensiveLlmGates(makeCtx(), makeLiquidity(false));
    expect(result).toEqual({ blocked: true });
    const logCall = mockedLogActivity.mock.calls[0];
    expect(logCall[2].details).toMatchObject({
      reason: "News veto: FOMC tier-1",
      source: "llm_trader",
    });
  });

  it("consec-loss halt is SKIPPED when config rules.prop_firm.consecutive_loss_daily_halt is 0", async () => {
    await checkDefensiveLlmGates(makeCtx({ rules: makeRules({}) }), makeLiquidity(false));
    expect(mockedCheckConsecLossHalt).not.toHaveBeenCalled();
  });

  it("consec-loss halt blocks when configured AND tripped", async () => {
    mockedCheckConsecLossHalt.mockResolvedValue({
      tripped: true,
      streak: 3,
      threshold: 3,
    });
    const result = await checkDefensiveLlmGates(
      makeCtx({ rules: makeRules({ consecutive_loss_daily_halt: 3 }) }),
      makeLiquidity(false)
    );
    expect(result).toEqual({ blocked: true });
    expect(mockedCheckConsecLossHalt).toHaveBeenCalledWith(
      expect.anything(),
      "algo-1",
      3
    );
    const logCall = mockedLogActivity.mock.calls[0];
    expect(logCall[2].details.reason).toContain("Consecutive-loss halt: 3/3");
  });

  it("re-entry cooldown blocks when checkReEntryCooldown returns block", async () => {
    mockedCheckReEntryCooldown.mockResolvedValue({
      block: true,
      reason: "Cooldown active",
      cooldown_minutes: 240,
      elapsed_minutes: 30,
      last_close_id: "pos-9",
      last_exit_reason: "stop_loss_hit",
      last_realized_pnl: -50,
    });
    const result = await checkDefensiveLlmGates(makeCtx(), makeLiquidity(false));
    expect(result).toEqual({ blocked: true });
    expect(mockedCheckReEntryCooldown).toHaveBeenCalledWith({
      supabase: expect.anything(),
      algorithmId: "algo-1",
      ticker: "XAU/USD",
      timeframe: "4h",
    });
    const logCall = mockedLogActivity.mock.calls[0];
    // Verify ALL 5 cooldown payload fields (the prior version omitted the
    // last 2, weakening the regression detector for refactors that might
    // rename the fields — caught by adversarial audit 2026-06-22).
    expect(logCall[2].details).toMatchObject({
      reason: "Cooldown active",
      cooldown_minutes: 240,
      elapsed_minutes: 30,
      last_close_id: "pos-9",
      last_exit_reason: "stop_loss_hit",
      last_realized_pnl: -50,
    });
  });

  it("consistency halt is SKIPPED when brokerCtx is null (live-only gate)", async () => {
    mockedCheckConsistencyHalt.mockResolvedValue({
      tripped: true, // would block if called
      today_net: 500,
      total_net: 1000,
      ratio: 0.5,
      threshold: 0.4,
    });
    const result = await checkDefensiveLlmGates(
      makeCtx({ rules: makeRules({ consistency_rule: 40 }), brokerCtx: null }),
      makeLiquidity(false)
    );
    expect(result).toEqual({ blocked: false });
    expect(mockedCheckConsistencyHalt).not.toHaveBeenCalled();
  });

  it("consistency halt blocks when configured AND brokerCtx set AND tripped", async () => {
    mockedCheckConsistencyHalt.mockResolvedValue({
      tripped: true,
      today_net: 500,
      total_net: 1000,
      ratio: 0.5,
      threshold: 0.4,
    });
    // Minimal broker-ctx stub — gate only checks truthiness, not shape.
    // Test fixture exemption to consistent-type-assertions justified.
    const stub = Object.create(null) as Record<string, unknown>;
    stub.adapter = Object.create(null);
    stub.conn = Object.create(null);
    const brokerCtx = stub as unknown as EntryContext["brokerCtx"];
    const result = await checkDefensiveLlmGates(
      makeCtx({ rules: makeRules({ consistency_rule: 40 }), brokerCtx }),
      makeLiquidity(false)
    );
    expect(result).toEqual({ blocked: true });
    const logCall = mockedLogActivity.mock.calls[0];
    expect(logCall[2].details.reason).toContain("Consistency halt");
  });

  it("ATR liquidity gate falls back to default reason when liquidity.reason is undefined", async () => {
    const liquidityUndefinedReason: ReturnType<typeof checkAtrLiquidity> = {
      skip: true,
      reason: undefined,
      atr_current: 5,
      atr_threshold: 10,
    };
    const result = await checkDefensiveLlmGates(makeCtx(), liquidityUndefinedReason);
    expect(result).toEqual({ blocked: true });
    const logCall = mockedLogActivity.mock.calls[0];
    expect(logCall[2].details.reason).toBe("ATR liquidity gate triggered");
  });

  it("re-entry cooldown falls back to default reason when cooldown.reason is undefined", async () => {
    mockedCheckReEntryCooldown.mockResolvedValue({
      block: true,
      // intentionally no `reason` field — exercises the `?? "Re-entry cooldown triggered"` fallback
    });
    const result = await checkDefensiveLlmGates(makeCtx(), makeLiquidity(false));
    expect(result).toEqual({ blocked: true });
    const logCall = mockedLogActivity.mock.calls[0];
    expect(logCall[2].details.reason).toBe("Re-entry cooldown triggered");
  });

  it("news-veto template tolerates undefined reason (defensive against mock-leakage / API drift)", async () => {
    mockedCheckNewsVeto.mockResolvedValue({ vetoed: true, reason: undefined });
    const result = await checkDefensiveLlmGates(makeCtx(), makeLiquidity(false));
    expect(result).toEqual({ blocked: true });
    const logCall = mockedLogActivity.mock.calls[0];
    // Template uses `News veto: ${veto.reason}` — if reason is undefined,
    // string interpolation produces "undefined" literal. Documenting the
    // current behaviour; a future fix might add a ?? fallback like other
    // gates do.
    expect(logCall[2].details.reason).toBe("News veto: undefined");
  });

  it("consistency halt SKIPPED when consistencyPct config is 0 (even with brokerCtx)", async () => {
    mockedCheckConsistencyHalt.mockResolvedValue({
      tripped: true, // would block if called
      today_net: 500,
      total_net: 1000,
      ratio: 0.5,
      threshold: 0.4,
    });
    const stub = Object.create(null) as Record<string, unknown>;
    stub.adapter = Object.create(null);
    stub.conn = Object.create(null);
    const brokerCtx = stub as unknown as EntryContext["brokerCtx"];
    const result = await checkDefensiveLlmGates(
      // No consistency_rule set in rules → defaults to 0 via `?? 0`
      makeCtx({ rules: makeRules({}), brokerCtx }),
      makeLiquidity(false)
    );
    expect(result).toEqual({ blocked: false });
    expect(mockedCheckConsistencyHalt).not.toHaveBeenCalled();
  });

  it("dead-hour gate fires BEFORE ATR liquidity gate (order check)", async () => {
    // Both would block — verify dead-hour wins (it's the first gate).
    mockedParseBarDate.mockReturnValue(new Date("2026-06-22T18:00:00Z"));
    await checkDefensiveLlmGates(makeCtx(), makeLiquidity(true));
    // Only the dead-hour log should fire; ATR log shouldn't.
    expect(mockedLogActivity).toHaveBeenCalledOnce();
    const logCall = mockedLogActivity.mock.calls[0];
    expect(logCall[2].details.reason).toContain("Dead-hour gate");
  });

  it("ATR gate fires BEFORE news veto (order check)", async () => {
    mockedCheckNewsVeto.mockResolvedValue({ vetoed: true, reason: "FOMC" });
    await checkDefensiveLlmGates(makeCtx(), makeLiquidity(true));
    expect(mockedLogActivity).toHaveBeenCalledOnce();
    const logCall = mockedLogActivity.mock.calls[0];
    expect(logCall[2].details.reason).toBe("ATR p20 floor");
    // News-veto check should never run after ATR blocks.
    expect(mockedCheckNewsVeto).not.toHaveBeenCalled();
  });
});
