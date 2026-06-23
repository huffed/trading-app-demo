/**
 * Tests for vol-target-sizing.ts. Locks the spec formula + warmup fallback
 * + floor semantics + rolling stddev edge cases.
 */
import { describe, expect, it } from "vitest";
import {
  computeVolTargetNotional,
  rollingPerTradeRStd,
  VOL_TARGET_WARMUP_FALLBACK_R_STD,
  DEFAULT_MIN_VOL_FLOOR,
} from "./vol-target-sizing";

describe("computeVolTargetNotional (spec formula)", () => {
  it("matches the spec formula exactly when no fallback or floor binds", () => {
    // capital=$10k × target=5% / (rStd=1.5 × instVol=0.005) = 500 / 0.0075 = 66,666.67
    const r = computeVolTargetNotional({
      capital: 10_000,
      target_vol_pct: 0.05,
      per_trade_r_std: 1.5,
      instrument_vol_pct: 0.005,
    });
    expect(r.notional).toBeCloseTo(66_666.67, 1);
    expect(r.effective_per_trade_r_std).toBe(1.5);
    expect(r.effective_vol_denominator).toBeCloseTo(0.0075, 6);
    expect(r.used_warmup_fallback).toBe(false);
    expect(r.floor_was_binding).toBe(false);
  });

  it("uses warmup fallback (1.0) when per_trade_r_std is null", () => {
    const r = computeVolTargetNotional({
      capital: 10_000,
      target_vol_pct: 0.05,
      per_trade_r_std: null,
      instrument_vol_pct: 0.005,
    });
    expect(r.effective_per_trade_r_std).toBe(VOL_TARGET_WARMUP_FALLBACK_R_STD);
    expect(r.used_warmup_fallback).toBe(true);
    // 500 / (1.0 × 0.005) = 100,000
    expect(r.notional).toBeCloseTo(100_000, 1);
  });

  it("uses warmup fallback on NaN / non-positive per_trade_r_std", () => {
    expect(computeVolTargetNotional({
      capital: 10_000, target_vol_pct: 0.05, per_trade_r_std: NaN, instrument_vol_pct: 0.005,
    }).used_warmup_fallback).toBe(true);
    expect(computeVolTargetNotional({
      capital: 10_000, target_vol_pct: 0.05, per_trade_r_std: 0, instrument_vol_pct: 0.005,
    }).used_warmup_fallback).toBe(true);
    expect(computeVolTargetNotional({
      capital: 10_000, target_vol_pct: 0.05, per_trade_r_std: -0.5, instrument_vol_pct: 0.005,
    }).used_warmup_fallback).toBe(true);
  });

  it("min_vol_floor binds when raw denominator goes below it (prevents explosive sizing)", () => {
    // rStd × instVol = 0.5 × 0.001 = 0.0005, below default floor 0.002
    const r = computeVolTargetNotional({
      capital: 10_000,
      target_vol_pct: 0.05,
      per_trade_r_std: 0.5,
      instrument_vol_pct: 0.001,
    });
    expect(r.floor_was_binding).toBe(true);
    expect(r.effective_vol_denominator).toBe(DEFAULT_MIN_VOL_FLOOR);
    // 500 / 0.002 = 250,000 (vs raw 1,000,000 without floor — 4× safer)
    expect(r.notional).toBe(250_000);
  });

  it("min_vol_floor override is honored", () => {
    const r = computeVolTargetNotional({
      capital: 10_000,
      target_vol_pct: 0.05,
      per_trade_r_std: 0.5,
      instrument_vol_pct: 0.001,
      min_vol_floor: 0.005, // tighter than default → smaller position
    });
    expect(r.effective_vol_denominator).toBe(0.005);
    expect(r.effective_min_vol_floor).toBe(0.005);
    expect(r.notional).toBe(100_000); // 500 / 0.005
  });

  it("returns 0 notional when capital is 0 or negative", () => {
    expect(computeVolTargetNotional({
      capital: 0, target_vol_pct: 0.05, per_trade_r_std: 1, instrument_vol_pct: 0.005,
    }).notional).toBe(0);
    expect(computeVolTargetNotional({
      capital: -1, target_vol_pct: 0.05, per_trade_r_std: 1, instrument_vol_pct: 0.005,
    }).notional).toBe(0);
  });

  it("handles negative / NaN instrument_vol_pct → instVol treated as 0 → floor binds", () => {
    const r = computeVolTargetNotional({
      capital: 10_000,
      target_vol_pct: 0.05,
      per_trade_r_std: 1,
      instrument_vol_pct: NaN,
    });
    expect(r.floor_was_binding).toBe(true);
    expect(r.effective_vol_denominator).toBe(DEFAULT_MIN_VOL_FLOOR);
    expect(r.notional).toBe(250_000);
  });

  it("zero target_vol_pct → zero notional (operator can opt out)", () => {
    expect(computeVolTargetNotional({
      capital: 10_000, target_vol_pct: 0, per_trade_r_std: 1, instrument_vol_pct: 0.005,
    }).notional).toBe(0);
  });
});

describe("rollingPerTradeRStd", () => {
  it("returns null for < 2 trades", () => {
    expect(rollingPerTradeRStd([])).toBeNull();
    expect(rollingPerTradeRStd([0.5])).toBeNull();
  });

  it("computes sample stddev (n-1 denominator) for canonical fixture", () => {
    // [1, 2, 3, 4, 5] mean=3 var=2.5 sd=√2.5 ≈ 1.5811
    expect(rollingPerTradeRStd([1, 2, 3, 4, 5])).toBeCloseTo(1.5811, 4);
  });

  it("uses only the most recent windowSize trades", () => {
    const allOnes = Array.from({ length: 50 }, (_, i) => (i < 30 ? 100 : 1));
    // Most recent 20 are all 1 → stddev 0
    expect(rollingPerTradeRStd(allOnes, 20)).toBeCloseTo(0, 6);
    // Most recent 30 covers some 100s + 1s → stddev > 0
    expect(rollingPerTradeRStd(allOnes, 30)).toBeGreaterThan(0);
  });

  it("default windowSize is 20", () => {
    // 25-element array where first 5 are wildly different from last 20
    // (all 1s for the last 20) — default window 20 sees only 1s → sd ≈ 0
    const trades = [100, -100, 100, -100, 100, ...Array(20).fill(1)];
    expect(rollingPerTradeRStd(trades)).toBeCloseTo(0, 6);
  });

  it("returns null when windowSize < 2 (invalid)", () => {
    expect(rollingPerTradeRStd([1, 2, 3, 4], 1)).toBeNull();
    expect(rollingPerTradeRStd([1, 2, 3, 4], 0)).toBeNull();
  });

  it("realistic gold-trade R series produces plausible stddev (~0.8–2.0)", () => {
    // Typical wide-SL 3R algo: many small losses (-1.0), few big wins (+3.0)
    const rs = [-1, -1, 3, -1, -1, -1, 3, -1, -1, -1, -1, 3, -1, -1, 3, -1, -1, -1, -1, 3];
    const sd = rollingPerTradeRStd(rs);
    expect(sd).not.toBeNull();
    expect(sd!).toBeGreaterThan(0.8);
    expect(sd!).toBeLessThan(2.5);
  });
});
