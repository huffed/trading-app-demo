import { describe, expect, it } from "vitest";
import type { AlgorithmRules } from "@/types/algorithm";
import { runPortfolioBacktest, type MarketStateSeries } from "./portfolio-backtest";
import type { PriceBar } from "./types";

function synthetic4hBars(n: number): PriceBar[] {
  const bars: PriceBar[] = [];
  const start = Date.UTC(2025, 0, 1);
  for (let i = 0; i < n; i++) {
    const ts = new Date(start + i * 4 * 3600 * 1000);
    const date = ts.toISOString().slice(0, 19).replace("T", " ");
    const drift = i * 0.05;
    const wiggle = Math.sin(i / 5) * 1.5;
    const close = 100 + drift + wiggle;
    const open = close - 0.3;
    bars.push({
      date,
      open,
      close,
      high: Math.max(open, close) + 0.5,
      low: Math.min(open, close) - 0.5,
      volume: 1000,
    });
  }
  return bars;
}

function baseRules(): AlgorithmRules {
  return {
    entry_conditions: [
      // RSI > 0 is true on every bar after warm-up — a deterministic
      // always-fire trigger so the test isolates the gate's effect.
      { type: "technical", indicator: "RSI", operator: "greater_than", value: 0, timeframe: "4h" },
    ],
    exit_conditions: [],
    stop_loss: { type: "percentage", value: 1.5 },
    take_profit: { type: "percentage", value: 3 },
    position_sizing: { type: "percentage_of_capital", value: 10 },
    max_positions: 1,
    timeframe: "4h",
    asset_class: "commodities",
    side: "long",
  } as AlgorithmRules;
}

describe("runPortfolioBacktest market_state_gate", () => {
  const bars = synthetic4hBars(700);
  const prices = new Map([["XAU/USD", bars]]);

  it("ungated rules produce trades (fixture sanity)", () => {
    const result = runPortfolioBacktest(baseRules(), prices, 100_000);
    expect(result.total_trades).toBeGreaterThan(0);
  });

  it("gated rules with NO marketStateSeries fail closed — zero trades", () => {
    const rules = baseRules();
    rules.market_state_gate = { mode: "allow", states: { vol: ["mid"] } };
    const result = runPortfolioBacktest(rules, prices, 100_000);
    expect(result.total_trades).toBe(0);
  });

  it("gated rules with full-depth series trade when the gate matches", () => {
    const rules = baseRules();
    // Every readable vol value is allowed — gate passes wherever the
    // percentile is computable, so trades exist but early unreadable
    // bars stay blocked (fail closed).
    rules.market_state_gate = { mode: "allow", states: { vol: ["low", "mid", "high"] } };
    const series: MarketStateSeries = {
      bars4h: new Map([["XAU/USD", bars]]),
      oneHour: new Map([["XAU/USD", []]]),
      eurusd4h: [],
    };
    const gated = runPortfolioBacktest(rules, prices, 100_000, [], null, series);
    const ungated = runPortfolioBacktest(baseRules(), prices, 100_000);
    expect(gated.total_trades).toBeGreaterThan(0);
    expect(gated.total_trades).toBeLessThanOrEqual(ungated.total_trades);
  });

  it("block-mode gate suppresses entries in blocked states only", () => {
    const rules = baseRules();
    rules.market_state_gate = {
      mode: "block",
      states: { vol: ["low", "mid", "high"] },
      on_unreadable: "allow",
    };
    const series: MarketStateSeries = {
      bars4h: new Map([["XAU/USD", bars]]),
      oneHour: new Map([["XAU/USD", []]]),
      eurusd4h: [],
    };
    // Blocking every readable vol value + allowing unreadable means only
    // the warm-up bars (vol n/a) can trade.
    const result = runPortfolioBacktest(rules, prices, 100_000, [], null, series);
    const ungated = runPortfolioBacktest(baseRules(), prices, 100_000);
    expect(result.total_trades).toBeLessThan(ungated.total_trades);
  });
});
