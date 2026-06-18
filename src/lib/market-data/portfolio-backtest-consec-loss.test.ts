import { describe, expect, it } from "vitest";
import { closeSimPosition, initialSimState } from "./prop-firm-backtest";
import type { BacktestTrade } from "./types";

const cfg = {
  slippageBps: 0,
  spreadBps: 0,
  commissionPct: 0,
  commissionPerLot: 0,
  maxPos: 1,
};

describe("R-aware consecutive-loss counter (B.1.1)", () => {
  it("legacy path: without slDistance, ANY loss increments the streak", () => {
    const s = initialSimState(10000);
    const trades: BacktestTrade[] = [];
    // Three micro losses, no slDistance → all count under legacy behaviour.
    for (let i = 0; i < 3; i++) {
      closeSimPosition(
        { entryPrice: 100, entryDate: "2026-01-01", notionalValue: 1000, side: "long" },
        "2026-01-01", 99.9, 10000, cfg, s, trades, "XAU/USD"
      );
    }
    expect(s.consecutiveLosses).toBe(3);
  });

  it("R-aware path: micro losses (< 0.25R) are SKIPPED (don't count)", () => {
    const s = initialSimState(10000);
    const trades: BacktestTrade[] = [];
    // slDistance = 1.0 on entryPrice=100, notional=1000 → 1R = 1000 × 1/100 = $10
    // Micro loss = -$1 (0.1R, below 0.25R cutoff) → should NOT count.
    for (let i = 0; i < 5; i++) {
      closeSimPosition(
        { entryPrice: 100, entryDate: "2026-01-01", notionalValue: 1000, side: "long", slDistance: 1.0 },
        "2026-01-01", 99.9, 10000, cfg, s, trades, "XAU/USD"
      );
    }
    expect(s.consecutiveLosses).toBe(0);
  });

  it("R-aware path: significant losses (≥ 0.25R) increment the streak", () => {
    const s = initialSimState(10000);
    const trades: BacktestTrade[] = [];
    // 1R = $10, threshold = 0.25R = $2.50. Loss of $5 (0.5R) counts.
    for (let i = 0; i < 3; i++) {
      closeSimPosition(
        { entryPrice: 100, entryDate: "2026-01-01", notionalValue: 1000, side: "long", slDistance: 1.0 },
        "2026-01-01", 99.5, 10000, cfg, s, trades, "XAU/USD"
      );
    }
    expect(s.consecutiveLosses).toBe(3);
  });

  it("R-aware path: micro losses don't break the streak (skip, not reset)", () => {
    const s = initialSimState(10000);
    const trades: BacktestTrade[] = [];
    // Loss 1: significant (-$5 = 0.5R) → streak=1
    closeSimPosition(
      { entryPrice: 100, entryDate: "2026-01-01", notionalValue: 1000, side: "long", slDistance: 1.0 },
      "2026-01-01", 99.5, 10000, cfg, s, trades, "XAU/USD"
    );
    expect(s.consecutiveLosses).toBe(1);

    // Loss 2: micro (-$1 = 0.1R) → SKIP (streak stays at 1, doesn't reset)
    closeSimPosition(
      { entryPrice: 100, entryDate: "2026-01-01", notionalValue: 1000, side: "long", slDistance: 1.0 },
      "2026-01-01", 99.9, 10000, cfg, s, trades, "XAU/USD"
    );
    expect(s.consecutiveLosses).toBe(1);

    // Loss 3: significant (-$5 = 0.5R) → streak=2 (NOT 1+1=2 because micro didn't break it)
    closeSimPosition(
      { entryPrice: 100, entryDate: "2026-01-01", notionalValue: 1000, side: "long", slDistance: 1.0 },
      "2026-01-01", 99.5, 10000, cfg, s, trades, "XAU/USD"
    );
    expect(s.consecutiveLosses).toBe(2);
  });

  it("Wins reset the streak (R-aware path)", () => {
    const s = initialSimState(10000);
    const trades: BacktestTrade[] = [];
    // 3 significant losses → streak=3
    for (let i = 0; i < 3; i++) {
      closeSimPosition(
        { entryPrice: 100, entryDate: "2026-01-01", notionalValue: 1000, side: "long", slDistance: 1.0 },
        "2026-01-01", 99.5, 10000, cfg, s, trades, "XAU/USD"
      );
    }
    expect(s.consecutiveLosses).toBe(3);

    // Win → reset to 0
    closeSimPosition(
      { entryPrice: 100, entryDate: "2026-01-01", notionalValue: 1000, side: "long", slDistance: 1.0 },
      "2026-01-01", 102, 10000, cfg, s, trades, "XAU/USD"
    );
    expect(s.consecutiveLosses).toBe(0);
  });

  it("maxConsecLosses tracks peak (R-aware path)", () => {
    const s = initialSimState(10000);
    const trades: BacktestTrade[] = [];
    // 2 significant losses, win, 3 significant losses → max=3
    for (let i = 0; i < 2; i++) {
      closeSimPosition(
        { entryPrice: 100, entryDate: "2026-01-01", notionalValue: 1000, side: "long", slDistance: 1.0 },
        "2026-01-01", 99.5, 10000, cfg, s, trades, "XAU/USD"
      );
    }
    closeSimPosition(
      { entryPrice: 100, entryDate: "2026-01-01", notionalValue: 1000, side: "long", slDistance: 1.0 },
      "2026-01-01", 102, 10000, cfg, s, trades, "XAU/USD"
    );
    for (let i = 0; i < 3; i++) {
      closeSimPosition(
        { entryPrice: 100, entryDate: "2026-01-01", notionalValue: 1000, side: "long", slDistance: 1.0 },
        "2026-01-01", 99.5, 10000, cfg, s, trades, "XAU/USD"
      );
    }
    expect(s.maxConsecLosses).toBe(3);
  });

  it("Zero slDistance falls back to legacy behaviour", () => {
    const s = initialSimState(10000);
    const trades: BacktestTrade[] = [];
    // slDistance = 0 → fallback to legacy (any loss counts)
    closeSimPosition(
      { entryPrice: 100, entryDate: "2026-01-01", notionalValue: 1000, side: "long", slDistance: 0 },
      "2026-01-01", 99.9, 10000, cfg, s, trades, "XAU/USD"
    );
    expect(s.consecutiveLosses).toBe(1);
  });
});
