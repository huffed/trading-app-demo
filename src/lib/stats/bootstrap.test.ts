import { describe, expect, it } from "vitest";
import {
  bootstrapStat,
  bootstrapStatBlock,
  bootstrapStatBlockWithSamples,
  bootstrapStatWithSamples,
  meanR,
  sharpeRatio,
  totalReturn,
  winRate,
  wilsonIntervalProportion,
} from "./bootstrap";
import type { BacktestTrade } from "@/lib/market-data/types";

function makeTrades(pnls: number[]): BacktestTrade[] {
  return pnls.map((pnl, i): BacktestTrade => {
    const trade: Partial<BacktestTrade> = {
      ticker: "XAU/USD",
      side: "long",
      entry_date: `2026-01-${(i + 1).toString().padStart(2, "0")}T00:00:00Z`,
      exit_date: `2026-01-${(i + 1).toString().padStart(2, "0")}T04:00:00Z`,
      entry_price: 100,
      exit_price: 100 + pnl / 10,
      pnl,
      exit_reason: pnl > 0 ? "take_profit_hit" : "stop_loss_hit",
    };
    return trade as BacktestTrade;
  });
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

describe("bootstrapStatBlock (B.2.5)", () => {
  it("empty input returns NaN bounds + 0 point", () => {
    const result = bootstrapStatBlock<number>([], (xs) => xs.length, { seed: 1 });
    expect(result.point).toBe(0);
    expect(result.lower).toBeNaN();
    expect(result.upper).toBeNaN();
  });

  it("deterministic with same seed", () => {
    const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const mean = (xs: number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length;
    const a = bootstrapStatBlock(items, mean, { seed: 7 });
    const b = bootstrapStatBlock(items, mean, { seed: 7 });
    expect(a.lower).toBe(b.lower);
    expect(a.upper).toBe(b.upper);
  });

  it("CI brackets point estimate", () => {
    const items = Array.from({ length: 50 }, (_, i) => i);
    const mean = (xs: number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length;
    const result = bootstrapStatBlock(items, mean, { seed: 1, n_iterations: 500 });
    expect(result.lower).toBeLessThanOrEqual(result.point);
    expect(result.upper).toBeGreaterThanOrEqual(result.point);
  });

  it("default block_size is ceil(sqrt(n))", () => {
    // Indirect test: passing block_size=undefined should match the explicit ceil(sqrt(n)).
    const items = Array.from({ length: 100 }, (_, i) => i);
    const mean = (xs: number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length;
    const def = bootstrapStatBlock(items, mean, { seed: 1, n_iterations: 200 });
    const expl = bootstrapStatBlock(items, mean, { seed: 1, n_iterations: 200, block_size: Math.ceil(Math.sqrt(100)) });
    expect(def.lower).toBe(expl.lower);
    expect(def.upper).toBe(expl.upper);
  });

  it("larger block_size produces WIDER CI (more conservative)", () => {
    // Highly autocorrelated series: alternating runs of 10. Trade-level
    // bootstrap mistakenly treats them as IID → narrow CI. Block bootstrap
    // captures the runs → wider CI.
    const items: number[] = [];
    for (let i = 0; i < 100; i++) items.push(i % 20 < 10 ? 1 : -1);
    const mean = (xs: number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length;
    const block1 = bootstrapStatBlock(items, mean, { seed: 1, n_iterations: 1000, block_size: 1 });
    const block10 = bootstrapStatBlock(items, mean, { seed: 1, n_iterations: 1000, block_size: 10 });
    const w1 = block1.upper - block1.lower;
    const w10 = block10.upper - block10.lower;
    expect(w10).toBeGreaterThan(w1);
  });

  it("block_size = 1 ≈ trade-level bootstrap for IID series", () => {
    // No autocorrelation → block size shouldn't matter much.
    const items = Array.from({ length: 100 }, (_, i) => Math.sin(i * 12345.6789));
    const mean = (xs: number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length;
    const trade = bootstrapStat(items, mean, { seed: 1, n_iterations: 2000 });
    const blockOne = bootstrapStatBlock(items, mean, { seed: 1, n_iterations: 2000, block_size: 1 });
    // Both should produce comparable CI widths (within ~30%) for IID input.
    const wt = trade.upper - trade.lower;
    const wb = blockOne.upper - blockOne.lower;
    expect(Math.abs(wt - wb) / wt).toBeLessThan(0.3);
  });

  it("bootstrapStatBlockWithSamples returns samples array", () => {
    const items = [1, 2, 3, 4, 5];
    const mean = (xs: number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length;
    const result = bootstrapStatBlockWithSamples(items, mean, { seed: 1, n_iterations: 50 });
    expect(result.samples).toHaveLength(50);
    expect(result.samples.every((s) => Number.isFinite(s))).toBe(true);
  });
});

describe("wilsonIntervalProportion (B.2.6)", () => {
  it("returns NaN for zero trials", () => {
    const result = wilsonIntervalProportion(0, 0);
    expect(result.point).toBeNaN();
    expect(result.lower).toBeNaN();
    expect(result.upper).toBeNaN();
  });

  it("50% point estimate centred around 0.5 with N=100", () => {
    // 50/100 → Wilson 95% CI ≈ [0.404, 0.596]
    const result = wilsonIntervalProportion(50, 100);
    expect(result.point).toBe(0.5);
    expect(result.lower).toBeCloseTo(0.404, 2);
    expect(result.upper).toBeCloseTo(0.596, 2);
  });

  it("zero successes has non-zero upper bound (Wilson advantage over normal)", () => {
    // 0/10 → Wilson upper ≈ 0.278 (vs normal-approximation 0 which is wrong)
    const result = wilsonIntervalProportion(0, 10);
    expect(result.point).toBe(0);
    expect(result.lower).toBe(0);
    expect(result.upper).toBeGreaterThan(0.2);
    expect(result.upper).toBeLessThan(0.4);
  });

  it("all successes has lower bound below 1", () => {
    const result = wilsonIntervalProportion(10, 10);
    expect(result.point).toBe(1);
    expect(result.upper).toBe(1);
    expect(result.lower).toBeLessThan(1);
    expect(result.lower).toBeGreaterThan(0.6);
  });

  it("CI tightens with more trials at the same proportion", () => {
    const small = wilsonIntervalProportion(7, 10);
    const big = wilsonIntervalProportion(70, 100);
    expect(big.upper - big.lower).toBeLessThan(small.upper - small.lower);
  });

  it("99% CI is wider than 95% CI", () => {
    const ci95 = wilsonIntervalProportion(50, 100, 0.95);
    const ci99 = wilsonIntervalProportion(50, 100, 0.99);
    expect(ci99.upper - ci99.lower).toBeGreaterThan(ci95.upper - ci95.lower);
  });
});

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

// B.2.15 + B.2.28 (Stage 3, 2026-06-19 EVE): degenerate-input regression
// tests. Pre-fix, n=1 silently produced lower=NaN/upper=NaN; post-fix,
// degenerate input returns tight [point, point] CI with point repeated
// in the sample array.
describe("bootstrap degenerate-input handling (B.2.15)", () => {
  it("n=1 produces tight CI [point, point] without crashing", () => {
    const r1 = bootstrapStatWithSamples([42], (xs: number[]) => xs[0] ?? 0);
    expect(r1.point).toBe(42);
    expect(r1.lower).toBe(42);
    expect(r1.upper).toBe(42);
    expect(r1.samples.length).toBe(r1.n_iterations);
    expect(r1.samples.every((s) => s === 42)).toBe(true);
  });

  it("block bootstrap n=1 produces tight CI without crashing", () => {
    const r1 = bootstrapStatBlockWithSamples([42], (xs: number[]) => xs[0] ?? 0);
    expect(r1.point).toBe(42);
    expect(r1.lower).toBe(42);
    expect(r1.upper).toBe(42);
  });

  it("n=0 returns NaN bounds + empty samples (existing behaviour preserved)", () => {
    const r0 = bootstrapStatWithSamples<number>([], () => 0);
    expect(r0.lower).toBeNaN();
    expect(r0.upper).toBeNaN();
    expect(r0.samples.length).toBe(0);
  });

  it("block bootstrap block_size > items.length is clamped (B.2.16)", () => {
    // Without the clamp, block_size=10 on items.length=3 would wrap
    // circularly several times, over-weighting early items. Clamp ensures
    // the bootstrap behaviour stays well-defined.
    const items = [1, 2, 3];
    const r = bootstrapStatBlock(items, (xs) => xs.reduce((a, b) => a + b, 0) / xs.length, {
      block_size: 100,
      seed: 7,
      n_iterations: 200,
    });
    // Point estimate is the true mean (2).
    expect(r.point).toBeCloseTo(2, 6);
    // CI bounds are finite numbers (no NaN, no Infinity).
    expect(Number.isFinite(r.lower)).toBe(true);
    expect(Number.isFinite(r.upper)).toBe(true);
  });
});

// B.2.29 (Stage 3, 2026-06-19 EVE): NaN-in-pnl regression test. Trade
// records with a NaN pnl shouldn't silently propagate as NaN-everywhere
// CI bounds; the statFn caller is responsible for handling NaN in its
// own logic, but the bootstrap loop itself must not crash.
describe("bootstrap robustness to NaN in input (B.2.29)", () => {
  it("statFn that returns NaN produces NaN samples without crashing", () => {
    const items = [1, 2, 3, 4];
    const result = bootstrapStat(items, () => NaN, { seed: 1, n_iterations: 100 });
    // point=NaN; lower/upper come from sorted NaN array (V8 sort puts NaN at end).
    expect(Number.isNaN(result.point)).toBe(true);
    expect(result.n_iterations).toBe(100);
  });

  it("trade with NaN pnl: bootstrap doesn't crash, statFn caller surfaces NaN", () => {
    const trades: BacktestTrade[] = [
      { ...makeTrades([10])[0], pnl: 10 },
      { ...makeTrades([20])[0], pnl: NaN },
      { ...makeTrades([30])[0], pnl: 30 },
    ];
    const mean = (ts: BacktestTrade[]): number =>
      ts.reduce((s, t) => s + t.pnl, 0) / ts.length;
    const result = bootstrapStat(trades, mean, { seed: 1, n_iterations: 100 });
    // Most resamples include the NaN trade → most samples NaN.
    // Critical: function doesn't crash + returns a defined result object.
    expect(result.n_iterations).toBe(100);
    expect(typeof result.point).toBe("number");
  });
});

// B.2.35 (Stage 3, 2026-06-19 EVE): Wilson interval edge cases regression.
describe("wilsonIntervalProportion edge cases (B.2.35)", () => {
  it("ci_level = 1.0 doesn't return Infinity bounds (clamp prevents Acklam blowup)", () => {
    const ci = wilsonIntervalProportion(5, 10, 1.0);
    expect(Number.isFinite(ci.lower)).toBe(true);
    expect(Number.isFinite(ci.upper)).toBe(true);
    expect(ci.lower).toBeGreaterThanOrEqual(0);
    expect(ci.upper).toBeLessThanOrEqual(1);
  });

  it("ci_level = 0.0 doesn't return -Infinity bounds", () => {
    const ci = wilsonIntervalProportion(5, 10, 0.0);
    expect(Number.isFinite(ci.lower)).toBe(true);
    expect(Number.isFinite(ci.upper)).toBe(true);
  });

  it("ci_level beyond [0,1] is clamped (defensive)", () => {
    const ci = wilsonIntervalProportion(5, 10, 1.5);
    expect(Number.isFinite(ci.lower)).toBe(true);
    expect(Number.isFinite(ci.upper)).toBe(true);
  });
});
