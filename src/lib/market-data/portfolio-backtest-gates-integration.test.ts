/**
 * B.1.11 — integration test for all 7 Phase B.1 fidelity gates composed.
 *
 * Verifies that enabling every gate simultaneously doesn't break the
 * engine (no crashes, no NaN, no contradictions). Doesn't try to make
 * each gate individually fire — that's covered by per-gate tests. The
 * point here is to catch the case where gate A's state mutation makes
 * gate B return wrong answers, or where gate ordering accidentally
 * skips some logic.
 */
import { describe, expect, it } from "vitest";
import {
  runPortfolioBacktest,
  type FtmoTerminationConfig,
  type PortfolioHaltConfig,
  type ReEntryCooldownConfig,
  type RiskPoolConfig,
  type SiblingTradeWindow,
  type SpreadGateConfig,
} from "./portfolio-backtest";
import type { AlgorithmRules } from "@/types/algorithm";
import type { PriceBar } from "./types";

function bar(date: string, o: number, h: number, l: number, c: number): PriceBar {
  return { date, open: o, high: h, low: l, close: c, volume: 0 };
}

const rules: AlgorithmRules = {
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
    consecutive_loss_daily_halt: 3,
    consistency_rule: 0,
    slippage_bps: 3,
    spread_bps: 0,
    commission_pct: 0,
  },
};

/** Long enough fixture for multiple entry opportunities + recovery cycles. */
function makeFixture(): PriceBar[] {
  const bars: PriceBar[] = [];
  let price = 100;
  let day = 1, month = 1;
  const next = (): string => {
    const d = day.toString().padStart(2, "0");
    const m = month.toString().padStart(2, "0");
    day++;
    if (day > 28) { day = 1; month++; }
    return `2026-${m}-${d}T04:00:00Z`;
  };
  for (let cycle = 0; cycle < 6; cycle++) {
    for (let i = 0; i < 20; i++) { bars.push(bar(next(), price, price + 1, price - 0.5, price + 0.8)); price += 0.8; }
    for (let i = 0; i < 15; i++) { bars.push(bar(next(), price, price + 0.3, price - 2, price - 1.5)); price -= 1.5; }
    for (let i = 0; i < 10; i++) { bars.push(bar(next(), price, price + 1.5, price - 0.3, price + 1.2)); price += 1.2; }
  }
  return bars;
}

describe("Phase B.1 all-gates integration (B.1.11)", () => {
  const bars = makeFixture();
  const prices = new Map([["XAU/USD", bars]]);

  const allGates = {
    directionConflictSiblings: [
      { ticker: "XAU/USD", side: "short" as const, entry_date: "2025-12-01T00:00:00Z", exit_date: "2026-01-15T00:00:00Z" },
    ] satisfies SiblingTradeWindow[],
    spreadGate: { enabled: true, threshold_multiplier: 2.5, atr_lookback_bars: 200 } satisfies SpreadGateConfig,
    riskPool: { enabled: true, pool_cap_pct: 4, reference_capital: 50000 } satisfies RiskPoolConfig,
    ftmoTermination: { enabled: true } satisfies FtmoTerminationConfig,
    riskPoolSiblings: [
      { ticker: "XAU/USD", side: "long" as const, entry_date: "2025-12-01T00:00:00Z", exit_date: "2026-02-15T00:00:00Z", risk_dollars: 800 },
    ] satisfies SiblingTradeWindow[],
    reEntryCooldown: { enabled: true } satisfies ReEntryCooldownConfig,
    portfolioHalt: { enabled: true, daily_loss_limit_pct: 5, reference_capital: 50000, sibling_daily_pnl: new Map() } satisfies PortfolioHaltConfig,
  };

  it("all 7 gates compose without errors", () => {
    expect(() => runPortfolioBacktest(
      rules, prices, 10000, [], null, null,
      allGates.directionConflictSiblings,
      allGates.spreadGate,
      allGates.riskPool,
      allGates.ftmoTermination,
      allGates.riskPoolSiblings,
      allGates.reEntryCooldown,
      allGates.portfolioHalt
    )).not.toThrow();
  });

  it("all-gates-on produces sane stats (no NaN in trade pnls / dates)", () => {
    const result = runPortfolioBacktest(
      rules, prices, 10000, [], null, null,
      allGates.directionConflictSiblings,
      allGates.spreadGate,
      allGates.riskPool,
      allGates.ftmoTermination,
      allGates.riskPoolSiblings,
      allGates.reEntryCooldown,
      allGates.portfolioHalt
    );
    for (const t of result.trades) {
      expect(Number.isFinite(t.pnl)).toBe(true);
      expect(Number.isFinite(t.entry_price)).toBe(true);
      expect(Number.isFinite(t.exit_price)).toBe(true);
      expect(typeof t.entry_date).toBe("string");
      expect(typeof t.exit_date).toBe("string");
      expect(t.side === "long" || t.side === "short").toBe(true);
    }
  });

  it("all-gates-on produces ≤ baseline trade count (no false positives)", () => {
    const baseline = runPortfolioBacktest(rules, prices, 10000);
    const allOn = runPortfolioBacktest(
      rules, prices, 10000, [], null, null,
      allGates.directionConflictSiblings,
      allGates.spreadGate,
      allGates.riskPool,
      allGates.ftmoTermination,
      allGates.riskPoolSiblings,
      allGates.reEntryCooldown,
      allGates.portfolioHalt
    );
    // Gates can only REJECT entries, never add them.
    expect(allOn.trades.length).toBeLessThanOrEqual(baseline.trades.length);
  });

  it("BacktestTrade.side is populated on every gated trade (B.1.5 invariant)", () => {
    const result = runPortfolioBacktest(
      rules, prices, 10000, [], null, null,
      allGates.directionConflictSiblings,
      allGates.spreadGate,
      allGates.riskPool,
      allGates.ftmoTermination,
      allGates.riskPoolSiblings,
      allGates.reEntryCooldown,
      allGates.portfolioHalt
    );
    expect(result.trades.every((t) => t.side === "long" || t.side === "short")).toBe(true);
  });

  it("disabling all gates + empty siblings = identical to legacy baseline", () => {
    const baseline = runPortfolioBacktest(rules, prices, 10000);
    const explicitOff = runPortfolioBacktest(
      rules, prices, 10000, [], null, null,
      [],
      null,  // spread off
      null,  // risk-pool off
      null,  // ftmo termination off
      [],
      null,  // re-entry cooldown off
      null   // portfolio-halt off
    );
    expect(explicitOff.trades.length).toBe(baseline.trades.length);
    expect(explicitOff.total_return).toBeCloseTo(baseline.total_return, 2);
  });
});
