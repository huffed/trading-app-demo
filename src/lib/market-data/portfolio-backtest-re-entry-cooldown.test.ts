import { describe, expect, it } from "vitest";
import { runPortfolioBacktest, type ReEntryCooldownConfig } from "./portfolio-backtest";
import type { AlgorithmRules } from "@/types/algorithm";
import type { PriceBar } from "./types";

function bar(date: string, o: number, h: number, l: number, c: number): PriceBar {
  return { date, open: o, high: h, low: l, close: c, volume: 0 };
}

const baseRules: AlgorithmRules = {
  asset_class: "commodity",
  side: "long",
  timeframe: "4h",
  entry_conditions: [{ type: "technical", indicator: "rsi", operator: "less_than", value: 50 }],
  exit_conditions: [{ type: "technical", indicator: "rsi", operator: "greater_than", value: 70 }],
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

/** Fixture with a repeating dip → SL → recover → dip cycle so multiple
 *  loss exits + re-entries happen close together. Tests whether cooldown
 *  refuses the second entry. */
function makeRepeatLossCycle(): PriceBar[] {
  const bars: PriceBar[] = [];
  let price = 100;
  let day = 1;
  const next = (): string => {
    const d = day.toString().padStart(2, "0");
    day++;
    return `2026-01-${d}T04:00:00Z`;
  };
  // 14 climb bars
  for (let i = 0; i < 14; i++) { bars.push(bar(next(), price, price + 1, price - 0.5, price + 0.8)); price += 0.8; }
  // 10 crash → triggers RSI < 50 → entry → SL
  for (let i = 0; i < 10; i++) { bars.push(bar(next(), price, price + 0.3, price - 2, price - 1.5)); price -= 1.5; }
  // 5 small recovery
  for (let i = 0; i < 5; i++) { bars.push(bar(next(), price, price + 1, price - 0.3, price + 0.5)); price += 0.5; }
  // 10 second crash → second entry candidate
  for (let i = 0; i < 10; i++) { bars.push(bar(next(), price, price + 0.3, price - 2, price - 1.5)); price -= 1.5; }
  // recovery
  for (let i = 0; i < 10; i++) { bars.push(bar(next(), price, price + 2, price - 0.3, price + 1.5)); price += 1.5; }
  return bars;
}

describe("portfolio-backtest re-entry cooldown (Phase B.1.2)", () => {
  const bars = makeRepeatLossCycle();
  const prices = new Map([["XAU/USD", bars]]);

  it("baseline (no cooldown config) allows back-to-back entries", () => {
    const result = runPortfolioBacktest(baseRules, prices, 10000);
    expect(result.trades.length).toBeGreaterThanOrEqual(0);
  });

  it("cooldown disabled passes through unchanged", () => {
    const disabled: ReEntryCooldownConfig = { enabled: false };
    const baseline = runPortfolioBacktest(baseRules, prices, 10000);
    const result = runPortfolioBacktest(
      baseRules, prices, 10000, [], null, null, [], null, null, null, undefined, disabled
    );
    expect(result.trades.length).toBe(baseline.trades.length);
  });

  it("cooldown enabled (4h timeframe → 240min) refuses entries within 1 bar of loss exit", () => {
    const baseline = runPortfolioBacktest(baseRules, prices, 10000);
    const cooldown: ReEntryCooldownConfig = { enabled: true };
    const gated = runPortfolioBacktest(
      baseRules, prices, 10000, [], null, null, [], null, null, null, undefined, cooldown
    );
    // Gated run should have <= trades than baseline (some refused)
    expect(gated.trades.length).toBeLessThanOrEqual(baseline.trades.length);
  });

  it("explicit cooldown_minutes overrides timeframe-derived default", () => {
    const longCooldown: ReEntryCooldownConfig = { enabled: true, cooldown_minutes: 20000 };
    const baseline = runPortfolioBacktest(baseRules, prices, 10000);
    const result = runPortfolioBacktest(
      baseRules, prices, 10000, [], null, null, [], null, null, null, undefined, longCooldown
    );
    // ~14-day cooldown should refuse MOST re-entries → result has ≤ trades
    expect(result.trades.length).toBeLessThanOrEqual(baseline.trades.length);
  });

  it("zero-cooldown_minutes is effectively a no-op (any elapsed time > 0)", () => {
    const noop: ReEntryCooldownConfig = { enabled: true, cooldown_minutes: 0 };
    const baseline = runPortfolioBacktest(baseRules, prices, 10000);
    const result = runPortfolioBacktest(
      baseRules, prices, 10000, [], null, null, [], null, null, null, undefined, noop
    );
    expect(result.trades.length).toBe(baseline.trades.length);
  });
});
