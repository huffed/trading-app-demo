import { describe, expect, it } from "vitest";
import { runPortfolioBacktest, type SpreadGateConfig } from "./portfolio-backtest";
import type { AlgorithmRules } from "@/types/algorithm";
import type { PriceBar } from "./types";

function bar(date: string, o: number, h: number, l: number, c: number): PriceBar {
  return { date, open: o, high: h, low: l, close: c, volume: 0 };
}

const baseRules: AlgorithmRules = {
  asset_class: "commodity",
  side: "long",
  timeframe: "4h",
  entry_conditions: [{ type: "technical", indicator: "rsi", operator: "less_than", value: 50, timeframe: "4h" }],
  exit_conditions: [{ type: "technical", indicator: "rsi", operator: "greater_than", value: 70, timeframe: "4h" }],
  entry_logic: "all",
  stop_loss: { type: "percentage", value: 1.5 },
  take_profit: { type: "percentage", value: 3 },
  position_sizing: { type: "risk_per_trade", value: 1 },
  max_positions: 1,
  max_per_ticker: 1,
  prop_firm: {
    daily_loss_limit: 5,
    max_drawdown: 10,
    profit_target: 10,
    max_consecutive_losses: 0,
    consistency_rule: 0,
    slippage_bps: 0,
    spread_bps: 0,
    commission_pct: 0,
  },
};

/** Calm price series (low ATR) followed by a single bar with massive ATR
 *  spike. Tests whether the spread-gate proxy correctly refuses entries
 *  in the high-vol bar. */
function makeAtrSpikeFixture(): PriceBar[] {
  const bars: PriceBar[] = [];
  let price = 100;
  // 250 calm bars — low ATR baseline
  for (let i = 0; i < 250; i++) {
    bars.push(bar(`2026-01-${(Math.floor(i / 6) + 1).toString().padStart(2, "0")}T${((i * 4) % 24).toString().padStart(2, "0")}:00:00Z`, price, price + 0.3, price - 0.3, price + (i % 2 === 0 ? 0.1 : -0.1)));
    price += (i % 2 === 0 ? 0.1 : -0.1);
  }
  // 5 spike bars — 10x normal range
  for (let i = 250; i < 255; i++) {
    bars.push(bar(`2026-02-${(i - 249).toString().padStart(2, "0")}T04:00:00Z`, price, price + 5, price - 5, price + (i % 2 === 0 ? 2 : -2)));
    price += (i % 2 === 0 ? 2 : -2);
  }
  // 10 more bars to give RSI conditions a chance to evaluate
  for (let i = 255; i < 265; i++) {
    bars.push(bar(`2026-02-${(i - 249).toString().padStart(2, "0")}T08:00:00Z`, price, price + 0.5, price - 0.5, price + (i % 3 === 0 ? 0.1 : -0.1)));
    price += (i % 3 === 0 ? 0.1 : -0.1);
  }
  return bars;
}

describe("portfolio-backtest spread gate (Phase B.1)", () => {
  const bars = makeAtrSpikeFixture();
  const prices = new Map([["XAU/USD", bars]]);

  it("baseline (no spread gate) allows entries regardless of ATR ratio", () => {
    const result = runPortfolioBacktest(baseRules, prices, 10000);
    // B.1.10: assert fixture produces trades so the gate tests are meaningful.
    expect(result.trades.length).toBeGreaterThan(0);
  });

  it("spread gate enabled refuses entries in high-ATR-ratio bars", () => {
    const baseline = runPortfolioBacktest(baseRules, prices, 10000);
    expect(baseline.trades.length).toBeGreaterThan(0);
    const gate: SpreadGateConfig = {
      enabled: true,
      threshold_multiplier: 2.5,
      atr_lookback_bars: 200,
    };
    const gated = runPortfolioBacktest(baseRules, prices, 10000, [], null, null, [], gate);
    // B.1.10: strict < (not <=) so a no-op gate would fail the test.
    expect(gated.trades.length).toBeLessThan(baseline.trades.length);
  });

  it("spread gate disabled is identical to no spread gate", () => {
    const disabled: SpreadGateConfig = {
      enabled: false,
      threshold_multiplier: 2.5,
      atr_lookback_bars: 200,
    };
    const baseline = runPortfolioBacktest(baseRules, prices, 10000);
    const disabledResult = runPortfolioBacktest(baseRules, prices, 10000, [], null, null, [], disabled);
    expect(disabledResult.trades.length).toBe(baseline.trades.length);
  });

  it("stricter threshold (1.5x) refuses more entries than 2.5x", () => {
    const strict: SpreadGateConfig = { enabled: true, threshold_multiplier: 1.5, atr_lookback_bars: 200 };
    const loose: SpreadGateConfig = { enabled: true, threshold_multiplier: 2.5, atr_lookback_bars: 200 };
    const strictResult = runPortfolioBacktest(baseRules, prices, 10000, [], null, null, [], strict);
    const looseResult = runPortfolioBacktest(baseRules, prices, 10000, [], null, null, [], loose);
    expect(strictResult.trades.length).toBeLessThanOrEqual(looseResult.trades.length);
  });

  it("very loose threshold (10x) is effectively a no-op", () => {
    const noop: SpreadGateConfig = { enabled: true, threshold_multiplier: 10, atr_lookback_bars: 200 };
    const baseline = runPortfolioBacktest(baseRules, prices, 10000);
    const noopResult = runPortfolioBacktest(baseRules, prices, 10000, [], null, null, [], noop);
    expect(noopResult.trades.length).toBe(baseline.trades.length);
  });

  it("with insufficient history (< 30 ATR samples) gate skips (allows)", () => {
    const shortBars = bars.slice(0, 20); // very short history
    const shortPrices = new Map([["XAU/USD", shortBars]]);
    const gate: SpreadGateConfig = { enabled: true, threshold_multiplier: 2.5, atr_lookback_bars: 200 };
    const baseline = runPortfolioBacktest(baseRules, shortPrices, 10000);
    const gated = runPortfolioBacktest(baseRules, shortPrices, 10000, [], null, null, [], gate);
    // With <30 ATR samples gate skips → behaves same as baseline
    expect(gated.trades.length).toBe(baseline.trades.length);
  });
});
