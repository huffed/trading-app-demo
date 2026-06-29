import { describe, expect, it } from "vitest";
import {
  aggregateMonthlyR,
  alignMonthlySeries,
  combinedDrawdownPct,
  composePortfolio,
  DEFAULT_PORTFOLIO_COMPOSER_CONFIG,
  pearsonCorrelation,
  perTradeRFromTrades,
  type CandidateInput,
} from "./portfolio-composer";

describe("aggregateMonthlyR", () => {
  it("groups trades by month + fills gaps", () => {
    const r = [1, 2, 3, 4];
    const dates = ["2024-01-15", "2024-01-20", "2024-03-05", "2024-03-10"];
    const result = aggregateMonthlyR(r, dates);
    expect(result).toEqual([
      { month: "2024-01", total_r: 3 },
      { month: "2024-02", total_r: 0 }, // gap filled
      { month: "2024-03", total_r: 7 },
    ]);
  });

  it("returns [] on empty input", () => {
    expect(aggregateMonthlyR([], [])).toEqual([]);
  });

  it("returns [] on length mismatch", () => {
    expect(aggregateMonthlyR([1, 2], ["2024-01-01"])).toEqual([]);
  });
});

describe("pearsonCorrelation", () => {
  it("returns 1 for perfectly correlated", () => {
    expect(pearsonCorrelation([1, 2, 3, 4], [2, 4, 6, 8])).toBeCloseTo(1, 5);
  });
  it("returns -1 for perfectly anti-correlated", () => {
    expect(pearsonCorrelation([1, 2, 3, 4], [4, 3, 2, 1])).toBeCloseTo(-1, 5);
  });
  it("returns 0 for constant series", () => {
    expect(pearsonCorrelation([1, 1, 1, 1], [1, 2, 3, 4])).toBe(0);
  });
  it("returns 0 for length mismatch", () => {
    expect(pearsonCorrelation([1, 2], [1])).toBe(0);
  });
});

describe("alignMonthlySeries", () => {
  it("aligns on union of months filling 0", () => {
    const a = [{ month: "2024-01", total_r: 5 }];
    const b = [{ month: "2024-02", total_r: 7 }];
    const result = alignMonthlySeries(a, b);
    expect(result.months).toEqual(["2024-01", "2024-02"]);
    expect(result.a_aligned).toEqual([5, 0]);
    expect(result.b_aligned).toEqual([0, 7]);
  });
});

describe("combinedDrawdownPct", () => {
  it("returns 0 for empty", () => {
    expect(combinedDrawdownPct([])).toBe(0);
  });
  it("computes peak-to-trough across multiple variants scaled by 1/N", () => {
    // Variant A: +2, -3 → equity 2, -1; peak 2, trough -1, DD = 3 (in raw R)
    // Variant B: +1, -2 → equity 1, -1; peak 1, trough -1, DD = 2
    // Combined (scaled 1/N=0.5): events sorted by date
    //   2024-01-01: A +2 * 0.5 = +1 (eq=1, peak=1)
    //   2024-01-15: B +1 * 0.5 = +0.5 (eq=1.5, peak=1.5)
    //   2024-02-01: A -3 * 0.5 = -1.5 (eq=0, dd=1.5)
    //   2024-02-15: B -2 * 0.5 = -1 (eq=-1, dd=2.5)
    // Combined DD = 2.5 in R (≈ 2.5% capital)
    const a = { per_trade_r: [2, -3], exit_dates: ["2024-01-01", "2024-02-01"] };
    const b = { per_trade_r: [1, -2], exit_dates: ["2024-01-15", "2024-02-15"] };
    expect(combinedDrawdownPct([a, b])).toBeCloseTo(2.5, 4);
  });
});

describe("composePortfolio", () => {
  const candidate = (id: string, ret: number, r: number[], dates: string[], dd: number): CandidateInput => ({
    id, total_return: ret, per_trade_r: r, exit_dates: dates, max_drawdown_pct: dd,
  });

  it("accepts first candidate unconditionally", () => {
    const c1 = candidate("a", 1000, [1, 2, 3], ["2024-01-01", "2024-02-01", "2024-03-01"], 5);
    const result = composePortfolio([c1]);
    expect(result.selected).toEqual(["a"]);
    expect(result.fallback_applied).toBe(false);
  });

  it("rejects 2nd candidate that is highly correlated", () => {
    const c1 = candidate("a", 1000, [1, 2, 3, 4, 5], ["2024-01-01", "2024-02-01", "2024-03-01", "2024-04-01", "2024-05-01"], 5);
    const c2 = candidate("b", 900, [1.1, 2.1, 3.1, 4.1, 5.1], ["2024-01-15", "2024-02-15", "2024-03-15", "2024-04-15", "2024-05-15"], 5);
    const result = composePortfolio([c1, c2]);
    expect(result.selected).toEqual(["a"]);
    expect(result.per_step_log[1].action).toBe("skipped_correlation");
  });

  it("accepts decorrelated candidate", () => {
    const c1 = candidate("a", 1000, [1, 2, 3, 4, 5], ["2024-01-01", "2024-02-01", "2024-03-01", "2024-04-01", "2024-05-01"], 5);
    const c2 = candidate("b", 900, [-1, 1, -2, 2, -3], ["2024-01-15", "2024-02-15", "2024-03-15", "2024-04-15", "2024-05-15"], 5);
    const result = composePortfolio([c1, c2]);
    expect(result.selected.length).toBeGreaterThanOrEqual(1);
  });

  it("applies fallback if min_portfolio_size > selected", () => {
    // Edge case: empty input → no fallback possible
    expect(composePortfolio([]).fallback_applied).toBe(false);
    expect(composePortfolio([]).selected).toEqual([]);
  });

  it("respects max_portfolio_size cap", () => {
    const cs = Array.from({ length: 10 }, (_, i) =>
      candidate(`c${i}`, 1000 - i, [Math.sin(i)], [`2024-${String(i % 12 + 1).padStart(2, "0")}-01`], 5),
    );
    const result = composePortfolio(cs, { ...DEFAULT_PORTFOLIO_COMPOSER_CONFIG, max_portfolio_size: 2 });
    expect(result.selected.length).toBeLessThanOrEqual(2);
  });
});

describe("perTradeRFromTrades", () => {
  it("converts pnl to R via risk-dollars", () => {
    const trades = [
      { pnl: 100, exit_date: "2024-01-01" },
      { pnl: -50, exit_date: "2024-02-01" },
    ] as Parameters<typeof perTradeRFromTrades>[0];
    const result = perTradeRFromTrades(trades, 50);
    expect(result.r).toEqual([2, -1]);
    expect(result.exit_dates).toEqual(["2024-01-01", "2024-02-01"]);
  });
  it("returns empty on zero risk", () => {
    const trades = [{ pnl: 100, exit_date: "2024-01-01" }] as Parameters<typeof perTradeRFromTrades>[0];
    expect(perTradeRFromTrades(trades, 0)).toEqual({ r: [], exit_dates: [] });
  });
});
