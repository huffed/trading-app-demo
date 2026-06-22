/**
 * CB.T1 Tier 3 — entry-side-and-direction-gates.ts (2026-06-23).
 *
 * Steps 7-11 of the deterministic entry ladder. Tests:
 *   - Side resolution null → blocked + insufficient-D1-history reason OR neutral-bias reason
 *   - Direction conflict → blocked with sibling reason + proposed_side payload
 *   - DXY filter blocked (when configured + dxyBars present)
 *   - Regime filter blocked
 *   - ADX filter blocked
 *   - Happy path → {blocked:false, side, directionOverride, higherTfBars}
 *   - dailyBars omitted → resampleToDaily called as fallback
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkDxyDirection } from "@/lib/algorithm/dxy-filter";
import { isWeakTrendByAdx } from "@/lib/market-data/adx-filter";
import { resolveSide } from "@/lib/market-data/auto-side";
import { isRangingByAtr } from "@/lib/market-data/regime-filter";
import { resampleToDaily } from "@/lib/market-data/resample";
import type { PriceBar } from "@/lib/market-data/types";
import type { AlgorithmRules } from "@/types/algorithm";
import { checkDirectionConflict } from "./entry-gates";
import { runSideAndDirectionGates } from "./entry-side-and-direction-gates";
import { logActivity } from "./helpers";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/algorithm/dxy-filter", () => ({ checkDxyDirection: vi.fn() }));
vi.mock("@/lib/market-data/adx-filter", () => ({ isWeakTrendByAdx: vi.fn() }));
vi.mock("@/lib/market-data/auto-side", () => ({ resolveSide: vi.fn() }));
vi.mock("@/lib/market-data/regime-filter", () => ({ isRangingByAtr: vi.fn() }));
vi.mock("@/lib/market-data/resample", () => ({ resampleToDaily: vi.fn() }));
vi.mock("./entry-gates", () => ({ checkDirectionConflict: vi.fn() }));
vi.mock("./helpers", () => ({ logActivity: vi.fn() }));

const mockedDxy = vi.mocked(checkDxyDirection);
const mockedAdx = vi.mocked(isWeakTrendByAdx);
const mockedResolve = vi.mocked(resolveSide);
const mockedRegime = vi.mocked(isRangingByAtr);
const mockedResample = vi.mocked(resampleToDaily);
const mockedConflict = vi.mocked(checkDirectionConflict);
const mockedLog = vi.mocked(logActivity);

function makeBars(n: number): PriceBar[] {
  return Array.from({ length: n }, (_, i) => ({
    date: `2026-06-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
    open: 100,
    high: 105,
    low: 95,
    close: 100,
    volume: 0,
  }));
}

function makeArgs(overrides: Record<string, unknown> = {}) {
  const stub = Object.create(null) as Record<string, unknown>;
  return {
    supabase: stub as unknown as SupabaseClient,
    userId: "user-1",
    algoId: "algo-1",
    ticker: "XAU/USD",
    rules: {
      timeframe: "4h",
      side: "long",
      asset_class: "commodities",
      position_sizing: { type: "risk_per_trade", value: 1 },
      stop_loss: { type: "percentage", value: 1 },
      take_profit: { type: "percentage", value: 2 },
      entry_conditions: [],
      exit_conditions: [],
    } as unknown as AlgorithmRules,
    bars: makeBars(50),
    dailyBars: makeBars(30),
    dxyBars: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedResolve.mockReturnValue({ side: "long", directionOverride: "bullish" });
  mockedConflict.mockResolvedValue({ block: false });
  mockedDxy.mockReturnValue({ block: false });
  mockedRegime.mockReturnValue({ skip: false });
  mockedAdx.mockReturnValue({ skip: false });
  mockedResample.mockReturnValue(makeBars(30));
  mockedLog.mockResolvedValue(undefined);
});

describe("runSideAndDirectionGates", () => {
  it("happy path → blocked:false with side + directionOverride + higherTfBars", async () => {
    const r = await runSideAndDirectionGates(makeArgs());
    expect(r).toMatchObject({
      blocked: false,
      side: "long",
      directionOverride: "bullish",
    });
  });

  it("side resolution null with insufficient D1 history (<20 bars) → blocked + specific reason", async () => {
    mockedResolve.mockReturnValue(null);
    const args = makeArgs({ dailyBars: makeBars(5) });
    const r = await runSideAndDirectionGates(args);
    expect(r).toEqual({ blocked: true });
    expect(mockedLog.mock.calls[0][2]).toMatchObject({
      details: { reason: expect.stringContaining("insufficient D1 history") },
    });
  });

  it("side resolution null with ≥20 D1 bars → blocked + 'neutral D1 bias' reason", async () => {
    mockedResolve.mockReturnValue(null);
    const r = await runSideAndDirectionGates(makeArgs());
    expect(r).toEqual({ blocked: true });
    expect(mockedLog.mock.calls[0][2]).toMatchObject({
      details: { reason: expect.stringContaining("neutral") },
    });
  });

  it("direction conflict blocks → reason + proposed_side + conflicting_algorithm_ids in payload", async () => {
    mockedConflict.mockResolvedValue({
      block: true,
      reason: "Sibling holding short",
      conflicting_algorithm_ids: ["algo-2"],
    });
    const r = await runSideAndDirectionGates(makeArgs());
    expect(r).toEqual({ blocked: true });
    expect(mockedLog.mock.calls[0][2]).toMatchObject({
      details: {
        reason: "Sibling holding short",
        proposed_side: "long",
        conflicting_algorithm_ids: ["algo-2"],
      },
    });
  });

  it("DXY filter blocked (when enabled + dxyBars present) → blocked + reason in payload", async () => {
    mockedDxy.mockReturnValue({
      block: true,
      reason: "DXY trending against long",
      status: "trending_up",
      delta_pips: 15,
      threshold_pips: 10,
      lookback_hours: 24,
    });
    const args = makeArgs({
      dxyBars: makeBars(50),
      rules: {
        ...makeArgs().rules,
        dxy_filter: { enabled: true, threshold_pips: 10, lookback_hours: 24 },
      } as unknown as AlgorithmRules,
    });
    const r = await runSideAndDirectionGates(args);
    expect(r).toEqual({ blocked: true });
    expect(mockedLog.mock.calls[0][2].details.reason).toBe("DXY trending against long");
  });

  it("DXY filter skipped when dxyBars empty (graceful pass)", async () => {
    mockedDxy.mockReturnValue({ block: true });
    const args = makeArgs({
      dxyBars: [],
      rules: {
        ...makeArgs().rules,
        dxy_filter: { enabled: true },
      } as unknown as AlgorithmRules,
    });
    const r = await runSideAndDirectionGates(args);
    expect(r.blocked).toBe(false);
    expect(mockedDxy).not.toHaveBeenCalled();
  });

  it("regime filter blocked → blocked + reason includes 'Regime filter:'", async () => {
    mockedRegime.mockReturnValue({ skip: true, reason: "ATR 5th percentile ranging" });
    const args = makeArgs({
      rules: {
        ...makeArgs().rules,
        regime_filter: { enabled: true, atr_percentile_threshold: 20, lookback: 200 },
      } as unknown as AlgorithmRules,
    });
    const r = await runSideAndDirectionGates(args);
    expect(r).toEqual({ blocked: true });
    expect(mockedLog.mock.calls[0][2].details.reason).toContain("Regime filter:");
  });

  it("ADX filter blocked → blocked + reason includes 'ADX filter:'", async () => {
    mockedAdx.mockReturnValue({ skip: true, reason: "ADX=18 below 25" });
    const args = makeArgs({
      rules: {
        ...makeArgs().rules,
        adx_filter: { enabled: true, min_adx: 25, lookback: 14 },
      } as unknown as AlgorithmRules,
    });
    const r = await runSideAndDirectionGates(args);
    expect(r).toEqual({ blocked: true });
    expect(mockedLog.mock.calls[0][2].details.reason).toContain("ADX filter:");
  });

  it("dailyBars undefined → resampleToDaily called as fallback", async () => {
    const args = makeArgs({ dailyBars: undefined });
    await runSideAndDirectionGates(args);
    expect(mockedResample).toHaveBeenCalledWith(args.bars);
  });

  it("dailyBars provided → resampleToDaily NOT called (already have higher-TF bars)", async () => {
    await runSideAndDirectionGates(makeArgs());
    expect(mockedResample).not.toHaveBeenCalled();
  });
});
