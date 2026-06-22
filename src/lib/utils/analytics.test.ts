import { describe, expect, it } from "vitest";
import type { Trade } from "@/types/trade";
import { computeDrawdownSeries, computeMetrics } from "./analytics";

// Mint a closed Trade fixture. Only the fields the analytics functions
// touch matter — the rest of the Trade shape is filled by `Partial<Trade>`
// at the call site, then narrowed through the function's return signature.
function trade(realizedPnl: number, exitDay: number): Trade {
  const t: Partial<Trade> = {
    status: "closed",
    realized_pnl: realizedPnl,
    exit_date: `2026-05-${String(exitDay).padStart(2, "0")}T00:00:00Z`,
    entry_date: `2026-05-${String(exitDay).padStart(2, "0")}T00:00:00Z`,
  };
  return t as Trade;
}

describe("computeDrawdownSeries — underwater from inception (the bug)", () => {
  it("returns non-zero drawdowns as % of starting capital when always underwater", () => {
    // Account starts at 0 P&L, every trade loses. Pre-fix this produced
    // a flat zero series because peak never exceeded 0. With starting
    // capital the chart now shows the meaningful trough.
    const trades = [trade(-100, 7), trade(-200, 8), trade(-150, 9)];
    const series = computeDrawdownSeries(trades, 50_000);
    expect(series).toHaveLength(3);
    expect(series[0].drawdown).toBeCloseTo(-0.2, 2); // -100 / 50000
    expect(series[1].drawdown).toBeCloseTo(-0.6, 2); // -300 / 50000
    expect(series[2].drawdown).toBeCloseTo(-0.9, 2); // -450 / 50000
    expect(series.every((p) => p.unit === "%")).toBe(true);
  });

  it("falls back to dollar drawdown when capital is unknown", () => {
    const trades = [trade(-100, 7), trade(-200, 8)];
    const series = computeDrawdownSeries(trades, null);
    expect(series[0].drawdown).toBeCloseTo(-100, 2);
    expect(series[1].drawdown).toBeCloseTo(-300, 2);
    expect(series.every((p) => p.unit === "$")).toBe(true);
  });

  it("rejects a zero or negative capital → dollar fallback", () => {
    const trades = [trade(-100, 7)];
    expect(computeDrawdownSeries(trades, 0)[0].unit).toBe("$");
    expect(computeDrawdownSeries(trades, -1)[0].unit).toBe("$");
  });
});

describe("computeDrawdownSeries — with peaks", () => {
  it("resets drawdown to 0 at a new peak", () => {
    const trades = [trade(500, 7), trade(-200, 8), trade(300, 9)];
    const series = computeDrawdownSeries(trades, 50_000);
    expect(series[0].drawdown).toBeCloseTo(0, 2); // new peak +500
    expect(series[1].drawdown).toBeCloseTo(-0.4, 2); // 300 below peak 500 = -0.4%
    expect(series[2].drawdown).toBeCloseTo(0, 2); // new peak +600
  });
});

describe("computeMetrics.maxDrawdownPercent — capital-aware", () => {
  it("computes max DD as % of starting capital for an underwater account", () => {
    // Real-world shape: 11 trades, net -$1,432 on $50K. The trough
    // happens at the worst running point — for this synthetic series
    // it's -$1,000 = 2% of $50K.
    const trades = [trade(-300, 7), trade(-400, 8), trade(-300, 9), trade(200, 10)];
    const m = computeMetrics(trades, 50_000);
    expect(m.maxDrawdown).toBeCloseTo(1_000, 0); // dollars
    expect(m.maxDrawdownPercent).toBeCloseTo(2, 2); // percent of capital
  });

  it("falls back to % of running peak when capital is unknown (legacy behaviour)", () => {
    const trades = [trade(1_000, 7), trade(-500, 8)];
    const m = computeMetrics(trades, null);
    expect(m.maxDrawdown).toBeCloseTo(500, 0);
    expect(m.maxDrawdownPercent).toBeCloseTo(50, 2); // 500 / peak 1000
  });
});
