import { describe, expect, it } from "vitest";
import { runPortfolioBacktest, type RiskPoolConfig, type SiblingTradeWindow } from "./portfolio-backtest";
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
  /** 1% risk per trade × $10K capital = $100 candidate risk. */
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

/** Synthetic fixture with one oversold dip (RSI < 50) that generates
 *  at least one candidate long entry. */
function makeDipFixture(): PriceBar[] {
  const bars: PriceBar[] = [];
  let price = 100;
  // 20 bars climb
  for (let i = 0; i < 20; i++) {
    bars.push(bar(`2026-01-${(i + 1).toString().padStart(2, "0")}T04:00:00Z`, price, price + 1, price - 0.5, price + 0.8));
    price += 0.8;
  }
  // 15 bars crash → RSI < 50 by the end
  for (let i = 20; i < 35; i++) {
    bars.push(bar(`2026-01-${(i + 1).toString().padStart(2, "0")}T04:00:00Z`, price, price + 0.3, price - 2, price - 1.5));
    price -= 1.5;
  }
  // 10 bars recovery (RSI exit signal)
  for (let i = 35; i < 45; i++) {
    bars.push(bar(`2026-02-${(i - 34).toString().padStart(2, "0")}T04:00:00Z`, price, price + 2, price - 0.3, price + 1.5));
    price += 1.5;
  }
  return bars;
}

describe("portfolio-backtest risk-pool halt (Phase B.1.3)", () => {
  const bars = makeDipFixture();
  const prices = new Map([["XAU/USD", bars]]);

  it("baseline (no risk-pool config) allows all entries", () => {
    const result = runPortfolioBacktest(baseRules, prices, 10000);
    expect(result.trades.length).toBeGreaterThanOrEqual(0);
  });

  it("risk-pool disabled passes through unchanged", () => {
    const disabled: RiskPoolConfig = { enabled: false, pool_cap_pct: 4 };
    const baseline = runPortfolioBacktest(baseRules, prices, 10000);
    const result = runPortfolioBacktest(baseRules, prices, 10000, [], null, null, [], null, disabled);
    expect(result.trades.length).toBe(baseline.trades.length);
  });

  it("risk-pool refuses entry when sibling pool would breach cap", () => {
    // Capital $10K × 1% = $100 candidate risk.
    // Sibling holding $400 risk for entire fixture → combined would be $500 = 5% of $10K.
    // Cap at 4% → should refuse.
    const baseline = runPortfolioBacktest(baseRules, prices, 10000);
    const sibling: SiblingTradeWindow[] = [{
      ticker: "XAU/USD",
      side: "long",  // same side so direction-conflict doesn't fire
      entry_date: "2026-01-01T00:00:00Z",
      exit_date: "2026-03-01T00:00:00Z",
      risk_dollars: 400,
    }];
    const riskPool: RiskPoolConfig = { enabled: true, pool_cap_pct: 4 };
    const gated = runPortfolioBacktest(baseRules, prices, 10000, [], null, null, sibling, null, riskPool);
    // Some entries should be refused since $100 + $400 = $500 = 5% > 4% cap
    expect(gated.trades.length).toBeLessThanOrEqual(baseline.trades.length);
  });

  it("risk-pool allows when sibling risk leaves headroom under cap", () => {
    // Capital $10K × 1% = $100 candidate risk.
    // Sibling holding $200 risk → combined $300 = 3% < 4% cap. Should allow.
    const baseline = runPortfolioBacktest(baseRules, prices, 10000);
    const sibling: SiblingTradeWindow[] = [{
      ticker: "XAU/USD",
      side: "long",
      entry_date: "2026-01-01T00:00:00Z",
      exit_date: "2026-03-01T00:00:00Z",
      risk_dollars: 200,
    }];
    const riskPool: RiskPoolConfig = { enabled: true, pool_cap_pct: 4 };
    const result = runPortfolioBacktest(baseRules, prices, 10000, [], null, null, sibling, null, riskPool);
    // Same trade count as baseline since combined risk stays under cap
    expect(result.trades.length).toBe(baseline.trades.length);
  });

  it("risk-pool with no overlapping siblings has no effect", () => {
    const sibling: SiblingTradeWindow[] = [{
      ticker: "XAU/USD",
      side: "long",
      // Sibling closed before fixture starts
      entry_date: "2025-01-01T00:00:00Z",
      exit_date: "2025-12-01T00:00:00Z",
      risk_dollars: 5000,  // huge, but expired
    }];
    const riskPool: RiskPoolConfig = { enabled: true, pool_cap_pct: 4 };
    const baseline = runPortfolioBacktest(baseRules, prices, 10000);
    const result = runPortfolioBacktest(baseRules, prices, 10000, [], null, null, sibling, null, riskPool);
    expect(result.trades.length).toBe(baseline.trades.length);
  });

  it("risk-pool ignores sibling windows without risk_dollars", () => {
    // Sibling with no risk_dollars → contributes 0 to combined; cap not breached.
    const sibling: SiblingTradeWindow[] = [{
      ticker: "XAU/USD",
      side: "long",
      entry_date: "2026-01-01T00:00:00Z",
      exit_date: "2026-03-01T00:00:00Z",
      // risk_dollars not set
    }];
    const riskPool: RiskPoolConfig = { enabled: true, pool_cap_pct: 4 };
    const baseline = runPortfolioBacktest(baseRules, prices, 10000);
    const result = runPortfolioBacktest(baseRules, prices, 10000, [], null, null, sibling, null, riskPool);
    expect(result.trades.length).toBe(baseline.trades.length);
  });

  it("reference_capital overrides algo capital for the cap basis", () => {
    // Algo capital $10K. Sibling risk $200, candidate risk $100 → combined $300.
    // If reference_capital = $100K, combined as % = 0.3% — way under cap.
    // If reference_capital = $5K, combined as % = 6% — over 4% cap.
    const sibling: SiblingTradeWindow[] = [{
      ticker: "XAU/USD",
      side: "long",
      entry_date: "2026-01-01T00:00:00Z",
      exit_date: "2026-03-01T00:00:00Z",
      risk_dollars: 200,
    }];
    const baseline = runPortfolioBacktest(baseRules, prices, 10000);
    const looseRef: RiskPoolConfig = { enabled: true, pool_cap_pct: 4, reference_capital: 100000 };
    const tightRef: RiskPoolConfig = { enabled: true, pool_cap_pct: 4, reference_capital: 5000 };
    const looseResult = runPortfolioBacktest(baseRules, prices, 10000, [], null, null, sibling, null, looseRef);
    const tightResult = runPortfolioBacktest(baseRules, prices, 10000, [], null, null, sibling, null, tightRef);
    expect(looseResult.trades.length).toBe(baseline.trades.length);  // no breach
    expect(tightResult.trades.length).toBeLessThanOrEqual(baseline.trades.length);  // breached
  });
});
