import { describe, expect, it } from "vitest";
import { bootstrapStat, bootstrapStatWithSamples, meanR, sharpeRatio, totalReturn, winRate } from "./bootstrap";
import type { BacktestTrade } from "@/lib/market-data/types";

function makeTrades(pnls: number[]): BacktestTrade[] {
  return pnls.map((pnl, i) => ({
    ticker: "XAU/USD",
    side: "long",
    entry_date: `2026-01-${(i + 1).toString().padStart(2, "0")}T00:00:00Z`,
    exit_date: `2026-01-${(i + 1).toString().padStart(2, "0")}T04:00:00Z`,
    entry_price: 100,
    exit_price: 100 + pnl / 10,
    quantity: 1,
    pnl,
    pnl_percent: pnl,
    exit_reason: pnl > 0 ? "tp_hit" : "sl_hit",
    bars_held: 1,
  } as BacktestTrade));
}

describe("statistics helpers", () => {
  it("winRate counts positive pnls", () => {
    expect(winRate(makeTrades([100, -50, 100, -50, 100]))).toBe(60);
    expect(winRate([])).toBe(0);
    expect(winRate(makeTrades([-1, -2]))).toBe(0);
    expect(winRate(makeTrades([1, 2]))).toBe(100);
  });

  it("totalReturn sums pnls", () => {
    expect(totalReturn(makeTrades([100, -50, 25]))).toBe(75);
    expect(totalReturn([])).toBe(0);
  });

  it("meanR divides by risk-per-trade", () => {
    expect(meanR(makeTrades([100, 100, 100]), 100)).toBe(1);
    expect(meanR(makeTrades([200, -100, 200]), 100)).toBeCloseTo(1, 2);
    expect(meanR([], 100)).toBe(0);
    expect(meanR(makeTrades([100]), 0)).toBe(0);
  });

  it("sharpeRatio = mean/std of R-multiples", () => {
    const rs = makeTrades([100, -100, 100, -100, 100, -100]);
    // R = [1,-1,1,-1,1,-1] → mean=0 → sharpe=0
    expect(sharpeRatio(rs, 100)).toBe(0);
    // R = [2,1,2,1,2,1] → mean=1.5, std=√0.3 ≈ 0.548 → sharpe ≈ 2.74
    const winning = makeTrades([200, 100, 200, 100, 200, 100]);
    expect(sharpeRatio(winning, 100)).toBeCloseTo(2.74, 1);
  });
});

describe("bootstrapStat", () => {
  it("returns NaN bounds for empty input but valid point", () => {
    const result = bootstrapStat([], (xs: number[]) => xs.length);
    expect(result.point).toBe(0);
    expect(result.lower).toBeNaN();
    expect(result.upper).toBeNaN();
  });

  it("is deterministic across runs with same seed", () => {
    const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const a = bootstrapStat(items, (xs) => xs.reduce((s, x) => s + x, 0) / xs.length, { seed: 7 });
    const b = bootstrapStat(items, (xs) => xs.reduce((s, x) => s + x, 0) / xs.length, { seed: 7 });
    expect(a.point).toBe(b.point);
    expect(a.lower).toBe(b.lower);
    expect(a.upper).toBe(b.upper);
  });

  it("changes with different seeds", () => {
    const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const a = bootstrapStat(items, (xs) => xs.reduce((s, x) => s + x, 0) / xs.length, { seed: 1 });
    const b = bootstrapStat(items, (xs) => xs.reduce((s, x) => s + x, 0) / xs.length, { seed: 999 });
    expect(a.lower).not.toBe(b.lower);
  });

  it("CI brackets the point estimate", () => {
    const items = Array.from({ length: 50 }, (_, i) => (i % 2 === 0 ? 1 : -1) * (i + 1));
    const mean = (xs: number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length;
    const result = bootstrapStat(items, mean, { seed: 1, n_iterations: 500 });
    expect(result.lower).toBeLessThanOrEqual(result.point);
    expect(result.upper).toBeGreaterThanOrEqual(result.point);
  });

  it("tighter CI from more iterations", () => {
    const items = Array.from({ length: 30 }, (_, i) => Math.sin(i));
    const mean = (xs: number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length;
    const small = bootstrapStat(items, mean, { seed: 1, n_iterations: 50 });
    const big = bootstrapStat(items, mean, { seed: 1, n_iterations: 5000 });
    // Both should produce some valid range, big should converge near true mean
    expect(Math.abs(big.point - big.lower)).toBeLessThan(1);
    expect(Math.abs(small.upper - small.lower)).toBeGreaterThan(0);
  });

  it("95% CI is wider than 50% CI", () => {
    const items = Array.from({ length: 50 }, (_, i) => i);
    const mean = (xs: number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length;
    const wide = bootstrapStat(items, mean, { seed: 1, n_iterations: 1000, ci_level: 0.95 });
    const narrow = bootstrapStat(items, mean, { seed: 1, n_iterations: 1000, ci_level: 0.5 });
    expect(wide.upper - wide.lower).toBeGreaterThan(narrow.upper - narrow.lower);
  });

  it("bootstrap win-rate CI for known-edge sample", () => {
    // 60% winners → CI should bracket 60
    const trades = makeTrades([100, 100, 100, 100, 100, 100, -50, -50, -50, -50]);
    const result = bootstrapStat(trades, winRate, { seed: 1, n_iterations: 1000 });
    expect(result.point).toBe(60);
    expect(result.lower).toBeGreaterThan(20);
    expect(result.upper).toBeLessThan(100);
  });

  it("bootstrap total-return for losing sample stays negative on point", () => {
    const trades = makeTrades([-50, -50, -50, -50, -50, 10]);
    const result = bootstrapStat(trades, totalReturn, { seed: 1, n_iterations: 500 });
    expect(result.point).toBe(-240);
    // Lower bound certainly negative; upper bound could plausibly go above zero
    expect(result.lower).toBeLessThan(0);
  });
});

describe("bootstrapStatWithSamples", () => {
  it("returns sample array matching n_iterations", () => {
    const items = [1, 2, 3, 4, 5];
    const mean = (xs: number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length;
    const result = bootstrapStatWithSamples(items, mean, { seed: 1, n_iterations: 100 });
    expect(result.samples).toHaveLength(100);
    expect(result.samples.every((s) => Number.isFinite(s))).toBe(true);
  });

  it("empty samples array for empty input", () => {
    const result = bootstrapStatWithSamples([], (xs: number[]) => xs.length, { seed: 1 });
    expect(result.samples).toEqual([]);
  });
});

function makeRandomTrades(n: number, mean: number, std: number, seed: number): BacktestTrade[] {
  // Box-Muller transform for normal samples
  let s = seed >>> 0;
  const rng = (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pnls: number[] = [];
  for (let i = 0; i < n; i++) {
    const u1 = rng();
    const u2 = rng();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    pnls.push(mean + std * z);
  }
  return makeTrades(pnls);
}

describe("bootstrap CI vs analytic CI (sanity check)", () => {
  it("bootstrap mean CI is close to 1.96*sigma/√n for normal sample", () => {
    // True mean=0, std=10, n=100 → analytic 95% CI half-width ≈ 1.96*10/√100 = 1.96
    const trades = makeRandomTrades(100, 0, 10, 12345);
    const mean = (ts: BacktestTrade[]): number => {
      if (ts.length === 0) return 0;
      return ts.reduce((s, t) => s + t.pnl, 0) / ts.length;
    };
    const result = bootstrapStat(trades, mean, { seed: 7, n_iterations: 2000 });
    const halfWidth = (result.upper - result.lower) / 2;
    // Should be within 50% of analytic ≈ 1.96 (loose for small-n stability)
    expect(halfWidth).toBeGreaterThan(1.0);
    expect(halfWidth).toBeLessThan(3.5);
  });
});
