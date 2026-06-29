import { describe, expect, it } from "vitest";
import {
  aggregateMonthlyR,
  alignMonthlySeries,
  combinedDailyDrawdownPct,
  combinedDrawdownPct,
  composePortfolio,
  DEFAULT_PORTFOLIO_COMPOSER_CONFIG,
  pearsonCorrelation,
  perTradePnlDollarsFromTrades,
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
      { month: "2024-02", total_r: 0 },
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

describe("combinedDrawdownPct (E2.11 dollar-pool sim)", () => {
  it("returns 0 for empty", () => {
    expect(combinedDrawdownPct([], 10000)).toBe(0);
  });
  it("returns 0 for zero capital", () => {
    expect(combinedDrawdownPct([{ per_trade_pnl_dollars: [1], exit_dates: ["2024-01-01"] }], 0)).toBe(0);
  });
  it("computes peak-to-trough at dollar precision (NOT R-scaled)", () => {
    // Algo A: +200, -300 on $10K pool → equity 10200, 9900; peak 10200, dd from peak = 300, DD% = 3.0%
    // Algo B: +100, -200 on same pool
    // Combined events sorted by date:
    //   2024-01-01: A +200 (eq=10200, peak=10200)
    //   2024-01-15: B +100 (eq=10300, peak=10300)
    //   2024-02-01: A -300 (eq=10000, dd=300)
    //   2024-02-15: B -200 (eq=9800, dd=500)
    // Combined DD = 500 / 10000 = 5.0%
    const a = { per_trade_pnl_dollars: [200, -300], exit_dates: ["2024-01-01", "2024-02-01"] };
    const b = { per_trade_pnl_dollars: [100, -200], exit_dates: ["2024-01-15", "2024-02-15"] };
    expect(combinedDrawdownPct([a, b], 10000)).toBeCloseTo(5.0, 4);
  });

  it("realistic stacking: 3 algos all losing simultaneously stacks DD (NOT 1/N proxy)", () => {
    // 3 algos each at $100 risk per trade, each loses $100 on same day
    // Combined DD = $300 / $10000 = 3.0% (NOT 1% which 1/N proxy would give)
    const a = { per_trade_pnl_dollars: [-100], exit_dates: ["2024-01-01"] };
    const b = { per_trade_pnl_dollars: [-100], exit_dates: ["2024-01-01"] };
    const c = { per_trade_pnl_dollars: [-100], exit_dates: ["2024-01-01"] };
    expect(combinedDrawdownPct([a, b, c], 10000)).toBeCloseTo(3.0, 4);
  });
});

describe("combinedDailyDrawdownPct", () => {
  it("returns worst single-day net PnL as %", () => {
    const a = { per_trade_pnl_dollars: [-100, +200], exit_dates: ["2024-01-01", "2024-01-02"] };
    const b = { per_trade_pnl_dollars: [-150, -50], exit_dates: ["2024-01-01", "2024-01-03"] };
    // Day 2024-01-01: -100 + -150 = -250 worst. -250/10000 = 2.5%
    expect(combinedDailyDrawdownPct([a, b], 10000)).toBeCloseTo(2.5, 4);
  });
  it("returns 0 for empty", () => {
    expect(combinedDailyDrawdownPct([], 10000)).toBe(0);
  });
});

describe("composePortfolio (E2.11 with realistic DD gate)", () => {
  const candidate = (id: string, ret: number, r: number[], pnl: number[], dates: string[], dd: number): CandidateInput => ({
    id, total_return: ret, per_trade_r: r, per_trade_pnl_dollars: pnl, exit_dates: dates, max_drawdown_pct: dd,
  });

  it("accepts first candidate that passes individual DD ceiling", () => {
    const c1 = candidate("a", 1000, [1, 2, 3], [100, 200, 300], ["2024-01-01", "2024-02-01", "2024-03-01"], 5);
    const result = composePortfolio([c1], { ...DEFAULT_PORTFOLIO_COMPOSER_CONFIG, pool_capital: 10000 });
    expect(result.selected).toEqual(["a"]);
    expect(result.fallback_applied).toBe(false);
  });

  it("skips first candidate that fails individual DD ceiling (E2.11 fix)", () => {
    // Big loss = 80% of pool ($8000 on $10K)
    const c1 = candidate("losing", 100, [-8], [-8000], ["2024-01-01"], 80);
    const c2 = candidate("safe", 50, [0.1, 0.2], [10, 20], ["2024-01-01", "2024-02-01"], 0.5);
    const result = composePortfolio([c1, c2], { ...DEFAULT_PORTFOLIO_COMPOSER_CONFIG, pool_capital: 10000, combined_portfolio_dd_ceiling: 5 });
    expect(result.selected).toEqual(["safe"]); // not "losing"
    expect(result.per_step_log[0].action).toBe("skipped_combined_dd");
  });

  it("rejects 2nd candidate that is highly correlated", () => {
    const c1 = candidate("a", 1000, [1, 2, 3, 4, 5], [100, 200, 300, 400, 500],
      ["2024-01-01", "2024-02-01", "2024-03-01", "2024-04-01", "2024-05-01"], 5);
    const c2 = candidate("b", 900, [1.1, 2.1, 3.1, 4.1, 5.1], [110, 210, 310, 410, 510],
      ["2024-01-15", "2024-02-15", "2024-03-15", "2024-04-15", "2024-05-15"], 5);
    const result = composePortfolio([c1, c2], { ...DEFAULT_PORTFOLIO_COMPOSER_CONFIG, pool_capital: 10000 });
    expect(result.selected).toEqual(["a"]);
    expect(result.per_step_log[1].action).toBe("skipped_correlation");
  });

  it("accepts decorrelated candidate when combined DD passes", () => {
    const c1 = candidate("a", 1000, [1, 2, 3, 4, 5], [10, 20, 30, 40, 50],
      ["2024-01-01", "2024-02-01", "2024-03-01", "2024-04-01", "2024-05-01"], 0.5);
    const c2 = candidate("b", 900, [-1, 1, -2, 2, -3], [-10, 10, -20, 20, -30],
      ["2024-01-15", "2024-02-15", "2024-03-15", "2024-04-15", "2024-05-15"], 0.5);
    const result = composePortfolio([c1, c2], { ...DEFAULT_PORTFOLIO_COMPOSER_CONFIG, pool_capital: 10000 });
    expect(result.selected.length).toBeGreaterThanOrEqual(1);
  });

  it("respects max_portfolio_size cap", () => {
    const cs = Array.from({ length: 10 }, (_, i) =>
      candidate(`c${i}`, 1000 - i, [Math.sin(i)], [10 * Math.sin(i)], [`2024-${String(i % 12 + 1).padStart(2, "0")}-01`], 0.5),
    );
    const result = composePortfolio(cs, { ...DEFAULT_PORTFOLIO_COMPOSER_CONFIG, pool_capital: 10000, max_portfolio_size: 2 });
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

describe("perTradePnlDollarsFromTrades (E2.11)", () => {
  it("extracts pnl + exit_date in dollar units", () => {
    const trades = [
      { pnl: 100, exit_date: "2024-01-01" },
      { pnl: -50, exit_date: "2024-02-01" },
    ] as Parameters<typeof perTradePnlDollarsFromTrades>[0];
    const result = perTradePnlDollarsFromTrades(trades);
    expect(result.pnl).toEqual([100, -50]);
    expect(result.exit_dates).toEqual(["2024-01-01", "2024-02-01"]);
  });
});
