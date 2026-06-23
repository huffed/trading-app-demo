/**
 * Tests for G.3 vol_target sizing wired into prop-firm-backtest's
 * sizeForBacktest + closeSimPosition R-multiple buffer.
 *
 * Locks: vol_target dispatch (uses computeVolTargetNotional output);
 * missing volTargetCtx → notional=0; closeSimPosition populates
 * rMultipleHistory with pnl/oneR; rolling cap enforced.
 */
import { describe, expect, it } from "vitest";
import { closeSimPosition, initialSimState, sizeForBacktest } from "./prop-firm-backtest";
import type { BacktestTrade } from "./types";
import type { AlgorithmRules } from "@/types/algorithm";

const baseSimCfg = {
  slippageBps: 0,
  spreadBps: 0,
  commissionPct: 0,
  commissionPerLot: 0,
  maxPos: 1,
  posSize: 0.01,
  stopLoss: { type: "percentage" as const, value: 1 },
  takeProfit: { type: "percentage" as const, value: 3 },
};

function volTargetRules(targetVolPct: number, opts?: { minFloor?: number; window?: number }): AlgorithmRules {
  return {
    entry_conditions: [],
    entry_logic: "all",
    stop_loss: { type: "percentage", value: 1 },
    take_profit: { type: "percentage", value: 3 },
    position_sizing: {
      type: "vol_target",
      value: targetVolPct,
      ...(opts?.minFloor != null ? { min_vol_floor: opts.minFloor } : {}),
      ...(opts?.window != null ? { rolling_window: opts.window } : {}),
    },
    max_positions: 1,
    timeframe: "4h",
    asset_class: "commodity",
  } as unknown as AlgorithmRules;
}

describe("sizeForBacktest vol_target branch", () => {
  it("dispatches to computeVolTargetNotional when sizing.type === 'vol_target'", () => {
    // 10k capital × 5% / (warmup rStd 1.0 × instVol 0.01) = 500 / 0.01 = 50,000
    const rules = volTargetRules(5);
    const sized = sizeForBacktest(rules, 10_000, 2000, "XAU/USD", baseSimCfg, 1, undefined, {
      instrumentVolPct: 0.01,
      rMultipleHistory: [],
    });
    expect(sized.notional).toBeCloseTo(50_000, 0);
    expect(sized.margin).toBeCloseTo(50_000 / 30, 0); // default leverage 30
  });

  it("uses rolling R-stddev from history when ≥ 2 trades available", () => {
    // R-mults [-1, 3, -1, 3] mean=1 var=(4+4+4+4)/3=5.333 sd≈2.309
    // 10k × 5% / (2.309 × 0.01) = 500 / 0.02309 ≈ 21,656
    const rules = volTargetRules(5);
    const sized = sizeForBacktest(rules, 10_000, 2000, "XAU/USD", baseSimCfg, 1, undefined, {
      instrumentVolPct: 0.01,
      rMultipleHistory: [-1, 3, -1, 3],
    });
    expect(sized.notional).toBeGreaterThan(21_000);
    expect(sized.notional).toBeLessThan(22_500);
  });

  it("returns 0 notional when volTargetCtx is missing (loud-fail by metric)", () => {
    const rules = volTargetRules(5);
    const sized = sizeForBacktest(rules, 10_000, 2000, "XAU/USD", baseSimCfg);
    expect(sized.notional).toBe(0);
    expect(sized.margin).toBe(0);
  });

  it("honors rolling_window override (small window sees only recent regime)", () => {
    // 50-element history: first 25 are wild (vol-dispersing), last 25 alternate
    // 1 and -1 (mean ≈ 0, stddev ≈ 1.02). Window=25 → only the recent regime.
    const history = [...Array(25).fill(10), ...Array.from({ length: 25 }, (_, i) => (i % 2 === 0 ? 1 : -1))];
    const rules = volTargetRules(5, { window: 25 });
    const sized = sizeForBacktest(rules, 10_000, 2000, "XAU/USD", baseSimCfg, 1, undefined, {
      instrumentVolPct: 0.01,
      rMultipleHistory: history,
    });
    // recent-25 stddev ≈ 1.02 → denominator = 1.02 × 0.01 = 0.0102
    // → notional = 500 / 0.0102 ≈ 49,020
    expect(sized.notional).toBeGreaterThan(48_000);
    expect(sized.notional).toBeLessThan(50_000);

    // Sanity: with window=50 (whole history including wild outliers) the
    // stddev is much larger (~4-5), pushing position much smaller.
    const widerRules = volTargetRules(5, { window: 50 });
    const sizedWider = sizeForBacktest(widerRules, 10_000, 2000, "XAU/USD", baseSimCfg, 1, undefined, {
      instrumentVolPct: 0.01,
      rMultipleHistory: history,
    });
    expect(sizedWider.notional).toBeLessThan(sized.notional); // wider window → bigger stddev → smaller position
  });

  it("honors min_vol_floor override (smaller floor → larger ceiling)", () => {
    const rules = volTargetRules(5, { minFloor: 0.005 });
    const sized = sizeForBacktest(rules, 10_000, 2000, "XAU/USD", baseSimCfg, 1, undefined, {
      instrumentVolPct: 0, // forces floor to bind
      rMultipleHistory: [],
    });
    expect(sized.notional).toBe(500 / 0.005); // 100,000
  });

  it("clamps effective leverage to 30 when prop_firm context present", () => {
    const rules = {
      ...volTargetRules(5),
      leverage: 100,
      prop_firm: { daily_loss_limit: 5, max_drawdown: 10, profit_target: 10, max_consecutive_losses: 0 },
    } as unknown as AlgorithmRules;
    const sized = sizeForBacktest(rules, 10_000, 2000, "XAU/USD", baseSimCfg, 1, undefined, {
      instrumentVolPct: 0.01,
      rMultipleHistory: [],
    });
    expect(sized.margin).toBeCloseTo(50_000 / 30, 0); // capped at 30, not 100
  });
});

describe("closeSimPosition rMultipleHistory population", () => {
  it("pushes pnl/oneR per closed trade with valid slDistance + notional + entry", () => {
    const s = initialSimState(10_000);
    const trades: BacktestTrade[] = [];
    // oneR = notional × (slDistance / entry) = 50000 × (10 / 2000) = 250
    // Long exit at 2010 → pnlPct = (2010-2000)/2000 = 0.005 → pnl = 50000×0.005 = 250 (1R win)
    closeSimPosition(
      {
        entryPrice: 2000,
        entryDate: "2026-06-01T00:00:00Z",
        notionalValue: 50_000,
        side: "long",
        slDistance: 10,
      },
      "2026-06-01",
      2010,
      10_000,
      baseSimCfg,
      s,
      trades,
      "XAU/USD",
    );
    expect(s.rMultipleHistory).toHaveLength(1);
    expect(s.rMultipleHistory[0]).toBeCloseTo(1.0, 2);
  });

  it("skips R-history push when slDistance is missing (broken-state position)", () => {
    const s = initialSimState(10_000);
    const trades: BacktestTrade[] = [];
    closeSimPosition(
      { entryPrice: 2000, entryDate: "x", notionalValue: 50_000, side: "long" }, // no slDistance
      "2026-06-01",
      2010,
      10_000,
      baseSimCfg,
      s,
      trades,
      "XAU/USD",
    );
    expect(s.rMultipleHistory).toHaveLength(0);
  });

  it("enforces R_MULTIPLE_HISTORY_CAP (≤ 200) on long backtests", () => {
    const s = initialSimState(10_000);
    s.rMultipleHistory = Array.from({ length: 199 }, () => 1);
    const trades: BacktestTrade[] = [];
    // Push 5 more → length becomes 204 → should trim to 200
    for (let i = 0; i < 5; i++) {
      closeSimPosition(
        { entryPrice: 2000, entryDate: "x", notionalValue: 50_000, side: "long", slDistance: 10 },
        "2026-06-01",
        2010,
        10_000,
        baseSimCfg,
        s,
        trades,
        "XAU/USD",
      );
    }
    expect(s.rMultipleHistory).toHaveLength(200);
  });

  it("records both wins and losses (≥1R magnitude and < 1R)", () => {
    const s = initialSimState(10_000);
    const trades: BacktestTrade[] = [];
    // Win: +250 = +1R
    closeSimPosition(
      { entryPrice: 2000, entryDate: "x", notionalValue: 50_000, side: "long", slDistance: 10 },
      "d", 2010, 10_000, baseSimCfg, s, trades, "XAU/USD",
    );
    // Loss: -125 = -0.5R
    closeSimPosition(
      { entryPrice: 2000, entryDate: "x", notionalValue: 50_000, side: "long", slDistance: 10 },
      "d", 1995, 10_000, baseSimCfg, s, trades, "XAU/USD",
    );
    expect(s.rMultipleHistory).toHaveLength(2);
    expect(s.rMultipleHistory[0]).toBeCloseTo(1.0, 2);
    expect(s.rMultipleHistory[1]).toBeCloseTo(-0.5, 2);
  });
});
