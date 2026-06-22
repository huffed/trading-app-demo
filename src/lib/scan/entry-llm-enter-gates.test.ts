/**
 * Unit tests for the LLM-trader enter-branch gates (CB.T1 pass 5,
 * 2026-06-22). Fifth test in `src/lib/scan/`. Tests the public
 * `checkLlmEnterGates` API — 5 sequential post-LLM-decision gates that
 * fire AFTER the LLM has returned enter_long/enter_short but BEFORE
 * `openPosition`.
 *
 * Gate order: RANGING → capped → dry-run → spread → drift.
 *
 * Coverage:
 *  - Pass-through: all gates inactive → { blocked: false }
 *  - RANGING block: legacy prompt (v3) + RANGING regime → blocked
 *  - RANGING block: v5 (multi-TF override) + RANGING regime → falls through
 *  - RANGING reason text: includes "legacy" when prompt_version undefined
 *  - Capped: cappedReason set → blocked with would_have_entered: true
 *  - Dry-run: llm_trader.dry_run flag set → blocked
 *  - Spread gate: brokerCtx + spread.block → blocked
 *  - Spread gate SKIPPED: no brokerCtx (paper-only)
 *  - Drift gate: drift.block → blocked with all 5 drift fields
 *  - Drift gate uses LAST close from closes[]
 *  - Order: RANGING fires before capped
 *  - Order: capped fires before dry-run
 *  - Order: spread gate calls checkBrokerSpread with (adapter, conn, ticker)
 *  - Drift fallback: drift.reason undefined → "Live-price drift gate triggered"
 *  - Spread fallback: spread.reason undefined → "Live spread gate triggered"
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkLivePriceDrift } from "@/lib/algorithm/live-price-drift-gate";
import { checkBrokerSpread } from "@/lib/algorithm/spread-gate";
import type { AlgorithmRules } from "@/types/algorithm";
import { checkLlmEnterGates } from "./entry-llm-enter-gates";
import { logActivity } from "./helpers";
import type { EntryContext } from "./entry";
import type { LlmTraderDecision, LlmTraderEvaluation } from "./llm-trader";
import type { SupabaseClient } from "@supabase/supabase-js";

// ---- Mocks. -----------------------------------------------------------
vi.mock("@/lib/algorithm/live-price-drift-gate", () => ({
  checkLivePriceDrift: vi.fn(),
}));
vi.mock("@/lib/algorithm/spread-gate", () => ({
  checkBrokerSpread: vi.fn(),
}));
vi.mock("./helpers", () => ({
  logActivity: vi.fn(),
}));

const mockedCheckLivePriceDrift = vi.mocked(checkLivePriceDrift);
const mockedCheckBrokerSpread = vi.mocked(checkBrokerSpread);
const mockedLogActivity = vi.mocked(logActivity);

// ---- Fixture builders. ------------------------------------------------
function makeRules(opts: {
  promptVersion?: string;
  dryRun?: boolean;
} = {}): AlgorithmRules {
  const llmTrader = Object.create(null) as Record<string, unknown>;
  llmTrader.enabled = true;
  if (opts.promptVersion !== undefined) llmTrader.prompt_version = opts.promptVersion;
  if (opts.dryRun !== undefined) llmTrader.dry_run = opts.dryRun;
  return {
    timeframe: "4h",
    llm_trader: llmTrader,
  } as unknown as AlgorithmRules;
}

function makeCtx(opts: {
  rules?: AlgorithmRules;
  brokerCtx?: EntryContext["brokerCtx"];
  cappedReason?: string | null;
  closes?: number[];
  livePrice?: number | null;
} = {}): EntryContext {
  return {
    supabase: Object.create(null) as SupabaseClient,
    userId: "user-1",
    algo: {
      id: "algo-1",
      name: "T",
      description: "",
      rules: opts.rules ?? makeRules({ promptVersion: "v5" }), // default: multi-TF override → no RANGING block
      capital: 10_000,
    },
    ticker: "XAU/USD",
    bars: [],
    closes: opts.closes ?? [3005, 3010],
    allOpenPositions: [],
    livePrice: opts.livePrice ?? 3010,
    brokerCtx: opts.brokerCtx ?? null,
    dailyBars: null,
    dxyBars: null,
    intermarket: null,
    cappedReason: opts.cappedReason ?? null,
    force: false,
  };
}

function makeBrokerCtx(): EntryContext["brokerCtx"] {
  const stub = Object.create(null) as Record<string, unknown>;
  stub.adapter = Object.create(null);
  stub.conn = Object.create(null);
  return stub as unknown as EntryContext["brokerCtx"];
}

const SAMPLE_DECISION: LlmTraderDecision = {
  decision: "enter_long",
  confidence: 80,
  reasoning: "HH continuation",
};
const SAMPLE_EVALUATION = { regime: "HH" } as unknown as LlmTraderEvaluation;
const RANGING_EVALUATION = { regime: "RANGING" } as unknown as LlmTraderEvaluation;

beforeEach(() => {
  vi.clearAllMocks();
  // Default mocks: no block from spread, no block from drift, no log calls.
  mockedCheckLivePriceDrift.mockReturnValue({
    block: false,
    bar_close: 3010,
    live_price: 3010,
    drift_pct: 0,
    drift_abs_pct: 0,
    threshold_pct: 0.2,
  });
  mockedCheckBrokerSpread.mockResolvedValue({
    block: false,
    status: "ok",
  });
  mockedLogActivity.mockResolvedValue(undefined);
});

// ======================================================================
// Pass-through baseline
// ======================================================================

describe("checkLlmEnterGates — pass-through baseline", () => {
  it("returns { blocked: false } + zero logs when all gates inactive", async () => {
    const result = await checkLlmEnterGates(
      makeCtx(),
      "long",
      SAMPLE_DECISION,
      SAMPLE_EVALUATION
    );
    expect(result).toEqual({ blocked: false });
    expect(mockedLogActivity).not.toHaveBeenCalled();
  });
});

// ======================================================================
// RANGING gate
// ======================================================================

describe("checkLlmEnterGates — RANGING regime gate", () => {
  it("blocks when regime=RANGING AND prompt is legacy v3 (no multi-TF override)", async () => {
    const result = await checkLlmEnterGates(
      makeCtx({ rules: makeRules({ promptVersion: "v3" }) }),
      "long",
      SAMPLE_DECISION,
      RANGING_EVALUATION
    );
    expect(result).toEqual({ blocked: true });
    expect(mockedLogActivity).toHaveBeenCalledOnce();
    const logCall = mockedLogActivity.mock.calls[0];
    expect(logCall[2].details).toMatchObject({
      reason: expect.stringContaining("RANGING regime block: 0/4 historical WR"),
      source: "llm_trader",
      regime: "RANGING",
      would_have_entered_side: "long",
    });
    // Verifies the v3 prompt name appears in the reason text (regression
    // detector for the template `${llmConfig?.prompt_version ?? "legacy"}`).
    expect(logCall[2].details.reason).toContain("v3 prompt");
  });

  it("falls through (no block) when regime=RANGING AND prompt is v5 (multi-TF override)", async () => {
    const result = await checkLlmEnterGates(
      makeCtx({ rules: makeRules({ promptVersion: "v5" }) }),
      "long",
      SAMPLE_DECISION,
      RANGING_EVALUATION
    );
    expect(result).toEqual({ blocked: false });
    expect(mockedLogActivity).not.toHaveBeenCalled();
  });

  it("falls through when regime is NOT RANGING (HH, LH, n/a) even with legacy prompt", async () => {
    for (const regime of ["HH", "LH", "n/a"]) {
      vi.clearAllMocks();
      mockedCheckLivePriceDrift.mockReturnValue({
        block: false,
        bar_close: 3010,
        live_price: 3010,
        drift_pct: 0,
        drift_abs_pct: 0,
        threshold_pct: 0.2,
      });
      const result = await checkLlmEnterGates(
        makeCtx({ rules: makeRules({ promptVersion: "v3" }) }),
        "long",
        SAMPLE_DECISION,
        { regime } as unknown as LlmTraderEvaluation
      );
      expect(result).toEqual({ blocked: false });
    }
  });

  it("RANGING reason text uses 'legacy' label when prompt_version is undefined", async () => {
    const result = await checkLlmEnterGates(
      makeCtx({ rules: makeRules({}) }), // no promptVersion
      "long",
      SAMPLE_DECISION,
      RANGING_EVALUATION
    );
    expect(result).toEqual({ blocked: true });
    const logCall = mockedLogActivity.mock.calls[0];
    expect(logCall[2].details.reason).toContain("legacy prompt");
  });
});

// ======================================================================
// Capped gate
// ======================================================================

describe("checkLlmEnterGates — capped (max_positions / max_per_ticker)", () => {
  it("blocks when cappedReason is set", async () => {
    const result = await checkLlmEnterGates(
      makeCtx({ cappedReason: "Capped: 1/1 positions open" }),
      "long",
      SAMPLE_DECISION,
      SAMPLE_EVALUATION
    );
    expect(result).toEqual({ blocked: true });
    const logCall = mockedLogActivity.mock.calls[0];
    expect(logCall[2].details).toMatchObject({
      reason: "Capped: 1/1 positions open",
      source: "llm_trader",
      regime: "HH",
      would_have_entered_side: "long",
      would_have_entered: true, // critical regression detector for "this was a viable entry"
    });
  });
});

// ======================================================================
// Dry-run gate
// ======================================================================

describe("checkLlmEnterGates — dry-run mode", () => {
  it("blocks when llm_trader.dry_run flag is true", async () => {
    const result = await checkLlmEnterGates(
      makeCtx({ rules: makeRules({ promptVersion: "v5", dryRun: true }) }),
      "long",
      SAMPLE_DECISION,
      SAMPLE_EVALUATION
    );
    expect(result).toEqual({ blocked: true });
    const logCall = mockedLogActivity.mock.calls[0];
    expect(logCall[2].details).toMatchObject({
      reason: "dry_run mode — would have entered",
      source: "llm_trader",
      regime: "HH",
      would_have_entered_side: "long",
    });
  });

  it("does NOT block when dry_run is false / unset", async () => {
    const result = await checkLlmEnterGates(
      makeCtx({ rules: makeRules({ promptVersion: "v5", dryRun: false }) }),
      "long",
      SAMPLE_DECISION,
      SAMPLE_EVALUATION
    );
    expect(result).toEqual({ blocked: false });
  });
});

// ======================================================================
// Spread gate
// ======================================================================

describe("checkLlmEnterGates — live spread gate", () => {
  it("SKIPS spread check when brokerCtx is null (paper-only mode)", async () => {
    const result = await checkLlmEnterGates(
      makeCtx({ brokerCtx: null }),
      "long",
      SAMPLE_DECISION,
      SAMPLE_EVALUATION
    );
    expect(result).toEqual({ blocked: false });
    expect(mockedCheckBrokerSpread).not.toHaveBeenCalled();
  });

  it("calls checkBrokerSpread with (adapter, conn, ticker) when brokerCtx is set", async () => {
    const brokerCtx = makeBrokerCtx();
    await checkLlmEnterGates(
      makeCtx({ brokerCtx }),
      "long",
      SAMPLE_DECISION,
      SAMPLE_EVALUATION
    );
    expect(mockedCheckBrokerSpread).toHaveBeenCalledOnce();
    const [adapterArg, connArg, tickerArg] = mockedCheckBrokerSpread.mock.calls[0];
    expect(adapterArg).toBe(brokerCtx?.adapter);
    expect(connArg).toBe(brokerCtx?.conn);
    expect(tickerArg).toBe("XAU/USD");
  });

  it("blocks when spread.block=true with reason + spread payload fields", async () => {
    mockedCheckBrokerSpread.mockResolvedValue({
      block: true,
      reason: "spread 2.5x catalog",
      observed_spread_pips: 4.5,
      threshold_pips: 1.8,
      status: "blocked",
    });
    const result = await checkLlmEnterGates(
      makeCtx({ brokerCtx: makeBrokerCtx() }),
      "long",
      SAMPLE_DECISION,
      SAMPLE_EVALUATION
    );
    expect(result).toEqual({ blocked: true });
    const logCall = mockedLogActivity.mock.calls[0];
    expect(logCall[2].details).toMatchObject({
      reason: "spread 2.5x catalog",
      source: "llm_trader",
      regime: "HH",
      observed_spread_pips: 4.5,
      threshold_pips: 1.8,
    });
  });

  it("falls back to default reason when spread.reason is undefined", async () => {
    mockedCheckBrokerSpread.mockResolvedValue({
      block: true,
      observed_spread_pips: 4.5,
      threshold_pips: 1.8,
      status: "blocked",
    });
    await checkLlmEnterGates(
      makeCtx({ brokerCtx: makeBrokerCtx() }),
      "long",
      SAMPLE_DECISION,
      SAMPLE_EVALUATION
    );
    const logCall = mockedLogActivity.mock.calls[0];
    expect(logCall[2].details.reason).toBe("Live spread gate triggered");
  });
});

// ======================================================================
// Live-price drift gate
// ======================================================================

describe("checkLlmEnterGates — live-price drift gate", () => {
  it("blocks when drift.block=true with ALL 5 drift payload fields", async () => {
    mockedCheckLivePriceDrift.mockReturnValue({
      block: true,
      reason: "drift 0.45% exceeds 0.20%",
      bar_close: 3000,
      live_price: 3013.5,
      drift_pct: 0.45,
      drift_abs_pct: 0.45,
      threshold_pct: 0.2,
    });
    const result = await checkLlmEnterGates(
      makeCtx(),
      "long",
      SAMPLE_DECISION,
      SAMPLE_EVALUATION
    );
    expect(result).toEqual({ blocked: true });
    const logCall = mockedLogActivity.mock.calls[0];
    expect(logCall[2].details).toMatchObject({
      reason: "drift 0.45% exceeds 0.20%",
      source: "llm_trader",
      regime: "HH",
      would_have_entered_side: "long",
      bar_close: 3000,
      live_price: 3013.5,
      drift_pct: 0.45,
      drift_abs_pct: 0.45,
      threshold_pct: 0.2,
    });
  });

  it("uses LAST close from closes[] as barClose argument", async () => {
    await checkLlmEnterGates(
      makeCtx({ closes: [3000, 3005, 3017.5] }),
      "long",
      SAMPLE_DECISION,
      SAMPLE_EVALUATION
    );
    expect(mockedCheckLivePriceDrift).toHaveBeenCalledWith({
      side: "long",
      barClose: 3017.5, // last element of closes[]
      livePrice: 3010,
    });
  });

  it("falls back to default reason when drift.reason is undefined", async () => {
    mockedCheckLivePriceDrift.mockReturnValue({
      block: true,
      bar_close: 3000,
      live_price: 3013.5,
      drift_pct: 0.45,
      drift_abs_pct: 0.45,
      threshold_pct: 0.2,
    });
    await checkLlmEnterGates(makeCtx(), "long", SAMPLE_DECISION, SAMPLE_EVALUATION);
    const logCall = mockedLogActivity.mock.calls[0];
    expect(logCall[2].details.reason).toBe("Live-price drift gate triggered");
  });
});

// ======================================================================
// Gate ladder order (early-return semantics)
// ======================================================================

describe("checkLlmEnterGates — gate ladder order", () => {
  it("RANGING fires BEFORE capped (when both would block)", async () => {
    const result = await checkLlmEnterGates(
      makeCtx({
        rules: makeRules({ promptVersion: "v3" }),
        cappedReason: "Capped: 1/1 positions open",
      }),
      "long",
      SAMPLE_DECISION,
      RANGING_EVALUATION
    );
    expect(result).toEqual({ blocked: true });
    expect(mockedLogActivity).toHaveBeenCalledOnce();
    const logCall = mockedLogActivity.mock.calls[0];
    // Should be RANGING, not capped
    expect(logCall[2].details.reason).toContain("RANGING regime block");
  });

  it("capped fires BEFORE dry-run (when both would block)", async () => {
    const result = await checkLlmEnterGates(
      makeCtx({
        rules: makeRules({ promptVersion: "v5", dryRun: true }),
        cappedReason: "Capped: 1/1 positions open",
      }),
      "long",
      SAMPLE_DECISION,
      SAMPLE_EVALUATION
    );
    expect(result).toEqual({ blocked: true });
    const logCall = mockedLogActivity.mock.calls[0];
    expect(logCall[2].details.reason).toBe("Capped: 1/1 positions open");
  });

  it("dry-run fires BEFORE spread (when both would block)", async () => {
    mockedCheckBrokerSpread.mockResolvedValue({
      block: true,
      reason: "spread too wide",
      observed_spread_pips: 5,
      threshold_pips: 2,
      status: "blocked",
    });
    await checkLlmEnterGates(
      makeCtx({
        rules: makeRules({ promptVersion: "v5", dryRun: true }),
        brokerCtx: makeBrokerCtx(),
      }),
      "long",
      SAMPLE_DECISION,
      SAMPLE_EVALUATION
    );
    const logCall = mockedLogActivity.mock.calls[0];
    expect(logCall[2].details.reason).toBe("dry_run mode — would have entered");
    // Spread gate's check should NOT have run (would have logged otherwise).
    expect(mockedCheckBrokerSpread).not.toHaveBeenCalled();
  });

  it("spread fires BEFORE drift (when both would block)", async () => {
    mockedCheckBrokerSpread.mockResolvedValue({
      block: true,
      reason: "spread too wide",
      observed_spread_pips: 5,
      threshold_pips: 2,
      status: "blocked",
    });
    mockedCheckLivePriceDrift.mockReturnValue({
      block: true,
      bar_close: 3000,
      live_price: 3013.5,
      drift_pct: 0.45,
      drift_abs_pct: 0.45,
      threshold_pct: 0.2,
    });
    await checkLlmEnterGates(
      makeCtx({ brokerCtx: makeBrokerCtx() }),
      "long",
      SAMPLE_DECISION,
      SAMPLE_EVALUATION
    );
    const logCall = mockedLogActivity.mock.calls[0];
    expect(logCall[2].details.reason).toBe("spread too wide");
    // Drift gate's check is unconditional (line 145) but its log shouldn't fire.
    expect(mockedLogActivity).toHaveBeenCalledOnce();
  });
});
