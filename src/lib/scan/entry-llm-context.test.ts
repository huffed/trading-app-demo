/**
 * Unit tests for the LLM-trader context builder (CB.T1 pass 4,
 * 2026-06-22). Fourth test in `src/lib/scan/`. Tests the public
 * `buildLlmTraderCtx` API; the two inner helpers (resolveHigherTfBars +
 * snapshotPosition) are exercised through it.
 *
 * Coverage:
 *  Multi-TF switch via resolveHigherTfBars (~7 tests):
 *   - No multi-TF override (legacy prompts) → undefined
 *   - undefined prompt_version → undefined
 *   - v5 + 30m primary → [{1h}, {4h}]
 *   - v5_15m + 15m primary → [{30m}, {1h}]
 *   - v2_mtf + 4h primary → [{1h}]
 *   - v5 + 1h primary → [{4h}]
 *   - v5 + unknown primary → []
 *
 *  Position snapshot via snapshotPosition (5 tests):
 *   - null position → position: null
 *   - All fields present → all populated
 *   - null stop_loss_price → stopPrice undefined (truthy coercion)
 *   - null initial_stop_loss_price → initialStopPrice undefined
 *   - null take_profit_price → targetPrice undefined
 *
 *  Full context construction (4 tests):
 *   - currentTimestamp from last bar
 *   - dailyBars ?? [] fallback
 *   - intermarket ?? undefined fallback
 *   - recentOutcomes from summariseRecentOutcomes
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resampleTo } from "@/lib/market-data/resample";
import type { AlgorithmRules } from "@/types/algorithm";
import type { PaperPosition } from "@/types/position";
import { buildLlmTraderCtx } from "./entry-llm-context";
import { summariseRecentOutcomes } from "./llm-trader-reflection";
import type { EntryContext } from "./entry";
import type { SupabaseClient } from "@supabase/supabase-js";

// ---- Mocks. -----------------------------------------------------------
vi.mock("@/lib/market-data/resample", () => ({
  resampleTo: vi.fn(),
}));
vi.mock("./llm-trader-reflection", () => ({
  summariseRecentOutcomes: vi.fn(),
}));

const mockedResampleTo = vi.mocked(resampleTo);
const mockedSummariseRecentOutcomes = vi.mocked(summariseRecentOutcomes);

// ---- Fixture builders. ------------------------------------------------
function makeRules(opts: {
  timeframe?: string;
  promptVersion?: string;
} = {}): AlgorithmRules {
  const llmTrader = Object.create(null) as Record<string, unknown>;
  if (opts.promptVersion !== undefined) {
    llmTrader.prompt_version = opts.promptVersion;
  }
  llmTrader.enabled = true;
  return {
    timeframe: opts.timeframe ?? "4h",
    llm_trader: llmTrader,
  } as unknown as AlgorithmRules;
}

function makeCtx(opts: {
  rules?: AlgorithmRules;
  dailyBars?: EntryContext["dailyBars"];
  dxyBars?: EntryContext["dxyBars"];
  intermarket?: EntryContext["intermarket"];
} = {}): EntryContext {
  return {
    supabase: Object.create(null) as SupabaseClient,
    userId: "user-1",
    algo: {
      id: "algo-1",
      name: "T",
      description: "",
      rules: opts.rules ?? makeRules(),
      capital: 10_000,
    },
    ticker: "XAU/USD",
    bars: [
      { date: "2026-06-22T08:00:00Z", open: 3000, high: 3010, low: 2990, close: 3005, volume: 100 },
      { date: "2026-06-22T12:00:00Z", open: 3005, high: 3015, low: 2995, close: 3010, volume: 100 },
    ],
    closes: [3005, 3010],
    allOpenPositions: [],
    livePrice: 3010,
    brokerCtx: null,
    dailyBars: opts.dailyBars ?? null,
    dxyBars: opts.dxyBars ?? null,
    intermarket: opts.intermarket ?? null,
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
    opened_at: "2026-06-22T06:00:00Z",
    stop_loss_price: 2990,
    initial_stop_loss_price: 2990,
    take_profit_price: 3020,
    ...overrides,
  });
  return stub as unknown as PaperPosition;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default summariseRecentOutcomes: null (warm-up phase, <10 trades).
  mockedSummariseRecentOutcomes.mockResolvedValue(null);
  // resampleTo: return a marker array so tests can verify which TF was
  // requested (different from input → easy to spot mis-routing).
  mockedResampleTo.mockImplementation((bars, tf) => [
    {
      date: `resampled-to-${tf}`,
      open: 0,
      high: 0,
      low: 0,
      close: 0,
      volume: 0,
    },
  ]);
});

// ======================================================================
// resolveHigherTfBars — multi-TF switch (exercised through buildLlmTraderCtx)
// ======================================================================

describe("buildLlmTraderCtx multi-TF resampling", () => {
  it("returns undefined higherTfBars when prompt_version is undefined", async () => {
    const ctx = makeCtx({ rules: makeRules({}) });
    const out = await buildLlmTraderCtx(ctx, null);
    expect(out.higherTfBars).toBeUndefined();
    expect(mockedResampleTo).not.toHaveBeenCalled();
  });

  it("returns undefined higherTfBars when prompt_version is legacy (v3) — no MTF override", async () => {
    const ctx = makeCtx({ rules: makeRules({ promptVersion: "v3" }) });
    const out = await buildLlmTraderCtx(ctx, null);
    expect(out.higherTfBars).toBeUndefined();
    expect(mockedResampleTo).not.toHaveBeenCalled();
  });

  it("v5 + 30m primary → resamples to [1h, 4h]", async () => {
    const ctx = makeCtx({
      rules: makeRules({ timeframe: "30m", promptVersion: "v5" }),
    });
    const out = await buildLlmTraderCtx(ctx, null);
    expect(out.higherTfBars).toHaveLength(2);
    expect(out.higherTfBars?.[0]).toMatchObject({ tfLabel: "1h" });
    expect(out.higherTfBars?.[1]).toMatchObject({ tfLabel: "4h" });
    expect(mockedResampleTo).toHaveBeenCalledTimes(2);
    expect(mockedResampleTo).toHaveBeenNthCalledWith(1, expect.any(Array), "1h");
    expect(mockedResampleTo).toHaveBeenNthCalledWith(2, expect.any(Array), "4h");
  });

  it("v5_15m + 15m primary → resamples to [30min, 1h] (note: '30min' not '30m')", async () => {
    const ctx = makeCtx({
      rules: makeRules({ timeframe: "15m", promptVersion: "v5_15m" }),
    });
    const out = await buildLlmTraderCtx(ctx, null);
    expect(out.higherTfBars).toHaveLength(2);
    expect(out.higherTfBars?.[0]).toMatchObject({ tfLabel: "30m" });
    expect(out.higherTfBars?.[1]).toMatchObject({ tfLabel: "1h" });
    // Critical: resample arg is "30min" not "30m" (the resampleTo lib's
    // canonical key). Regression detector for the rename.
    expect(mockedResampleTo).toHaveBeenNthCalledWith(1, expect.any(Array), "30min");
    expect(mockedResampleTo).toHaveBeenNthCalledWith(2, expect.any(Array), "1h");
  });

  it("v2_mtf + 4h primary → resamples to [1h] only (faster-pulse early warning)", async () => {
    const ctx = makeCtx({
      rules: makeRules({ timeframe: "4h", promptVersion: "v2_mtf" }),
    });
    const out = await buildLlmTraderCtx(ctx, null);
    expect(out.higherTfBars).toHaveLength(1);
    expect(out.higherTfBars?.[0]).toMatchObject({ tfLabel: "1h" });
  });

  it("v5 + 1h primary → resamples to [4h] only (single higher TF)", async () => {
    const ctx = makeCtx({
      rules: makeRules({ timeframe: "1h", promptVersion: "v5" }),
    });
    const out = await buildLlmTraderCtx(ctx, null);
    expect(out.higherTfBars).toHaveLength(1);
    expect(out.higherTfBars?.[0]).toMatchObject({ tfLabel: "4h" });
  });

  it("multi-TF prompt + unrecognised primary timeframe → empty array (default switch branch)", async () => {
    const ctx = makeCtx({
      rules: makeRules({ timeframe: "5m", promptVersion: "v5" }),
    });
    const out = await buildLlmTraderCtx(ctx, null);
    expect(out.higherTfBars).toEqual([]);
    expect(mockedResampleTo).not.toHaveBeenCalled();
  });
});

// ======================================================================
// snapshotPosition (exercised through buildLlmTraderCtx)
// ======================================================================

describe("buildLlmTraderCtx position snapshot", () => {
  it("position: null when currentPosition is null", async () => {
    const out = await buildLlmTraderCtx(makeCtx(), null);
    expect(out.position).toBeNull();
  });

  it("populates all 6 position fields with Number() coercion", async () => {
    const pos = makePosition();
    const out = await buildLlmTraderCtx(makeCtx(), pos);
    expect(out.position).toEqual({
      side: "long",
      entryPrice: 3000,
      entryDate: "2026-06-22T06:00:00Z",
      stopPrice: 2990,
      initialStopPrice: 2990,
      targetPrice: 3020,
    });
  });

  it("stopPrice undefined when stop_loss_price is null (truthy-coercion, not ??)", async () => {
    const pos = makePosition({ stop_loss_price: null });
    const out = await buildLlmTraderCtx(makeCtx(), pos);
    expect(out.position?.stopPrice).toBeUndefined();
  });

  it("initialStopPrice undefined when initial_stop_loss_price is null (legacy pre-migration row)", async () => {
    const pos = makePosition({ initial_stop_loss_price: null });
    const out = await buildLlmTraderCtx(makeCtx(), pos);
    expect(out.position?.initialStopPrice).toBeUndefined();
  });

  it("targetPrice undefined when take_profit_price is null", async () => {
    const pos = makePosition({ take_profit_price: null });
    const out = await buildLlmTraderCtx(makeCtx(), pos);
    expect(out.position?.targetPrice).toBeUndefined();
  });
});

// ======================================================================
// Full context construction
// ======================================================================

describe("buildLlmTraderCtx full context shape", () => {
  it("currentTimestamp set from last bar's date", async () => {
    const out = await buildLlmTraderCtx(makeCtx(), null);
    expect(out.currentTimestamp).toBe("2026-06-22T12:00:00Z");
  });

  it("dailyBars falls back to [] when ctx.dailyBars is null", async () => {
    const out = await buildLlmTraderCtx(makeCtx({ dailyBars: null }), null);
    expect(out.dailyBars).toEqual([]);
  });

  it("dailyBars passes through when ctx.dailyBars is set", async () => {
    const dailyBars = [
      { date: "2026-06-22", open: 3000, high: 3010, low: 2990, close: 3005, volume: 100 },
    ];
    const out = await buildLlmTraderCtx(makeCtx({ dailyBars }), null);
    expect(out.dailyBars).toBe(dailyBars);
  });

  it("intermarket falls back to undefined when ctx.intermarket is null", async () => {
    const out = await buildLlmTraderCtx(makeCtx({ intermarket: null }), null);
    expect(out.intermarket).toBeUndefined();
  });

  it("intermarket passes through when ctx.intermarket is set", async () => {
    const intermarket = { silver: [], yield10y: [], vix: [] };
    const out = await buildLlmTraderCtx(makeCtx({ intermarket }), null);
    expect(out.intermarket).toBe(intermarket);
  });

  it("recentOutcomes pulled from summariseRecentOutcomes(supabase, algo.id)", async () => {
    mockedSummariseRecentOutcomes.mockResolvedValue(
      "Last 10: 6W/4L, HH wins more than LH"
    );
    const out = await buildLlmTraderCtx(makeCtx(), null);
    expect(out.recentOutcomes).toBe("Last 10: 6W/4L, HH wins more than LH");
    expect(mockedSummariseRecentOutcomes).toHaveBeenCalledWith(
      expect.anything(),
      "algo-1"
    );
  });

  it("recentOutcomes is null during warm-up (summariseRecentOutcomes returns null)", async () => {
    mockedSummariseRecentOutcomes.mockResolvedValue(null);
    const out = await buildLlmTraderCtx(makeCtx(), null);
    expect(out.recentOutcomes).toBeNull();
  });

  it("timeframe passed through from algo.rules.timeframe", async () => {
    const out = await buildLlmTraderCtx(
      makeCtx({ rules: makeRules({ timeframe: "1h" }) }),
      null
    );
    expect(out.timeframe).toBe("1h");
  });
});
