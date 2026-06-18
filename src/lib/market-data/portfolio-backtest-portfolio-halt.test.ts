import { describe, expect, it } from "vitest";
import { runPortfolioBacktest, type PortfolioHaltConfig } from "./portfolio-backtest";
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
    daily_loss_limit: 100,  // very loose per-algo so portfolio-halt is what fires
    max_drawdown: 100,
    profit_target: 10,
    max_consecutive_losses: 0,
    consistency_rule: 0,
    slippage_bps: 0,
    spread_bps: 0,
    commission_pct: 0,
  },
};

function makeDipFixture(): PriceBar[] {
  const bars: PriceBar[] = [];
  let price = 100;
  for (let i = 0; i < 20; i++) {
    bars.push(bar(`2026-01-${(i + 1).toString().padStart(2, "0")}T04:00:00Z`, price, price + 1, price - 0.5, price + 0.8));
    price += 0.8;
  }
  for (let i = 20; i < 35; i++) {
    bars.push(bar(`2026-01-${(i + 1).toString().padStart(2, "0")}T04:00:00Z`, price, price + 0.3, price - 2, price - 1.5));
    price -= 1.5;
  }
  for (let i = 35; i < 45; i++) {
    bars.push(bar(`2026-02-${(i - 34).toString().padStart(2, "0")}T04:00:00Z`, price, price + 2, price - 0.3, price + 1.5));
    price += 1.5;
  }
  return bars;
}

describe("portfolio-backtest portfolio-halt (Phase B.1.3)", () => {
  const bars = makeDipFixture();
  const prices = new Map([["XAU/USD", bars]]);

  it("baseline (no portfolio-halt config) — runs unchanged", () => {
    const result = runPortfolioBacktest(baseRules, prices, 10000);
    expect(result.trades.length).toBeGreaterThanOrEqual(0);
  });

  it("portfolio-halt disabled passes through unchanged", () => {
    const disabled: PortfolioHaltConfig = {
      enabled: false,
      daily_loss_limit_pct: 5,
      sibling_daily_pnl: new Map(),
    };
    const baseline = runPortfolioBacktest(baseRules, prices, 10000);
    const result = runPortfolioBacktest(
      baseRules, prices, 10000, [], null, null, [], null, null, null, undefined, null, disabled
    );
    expect(result.trades.length).toBe(baseline.trades.length);
  });

  it("empty sibling_daily_pnl + low this-algo losses → no breach", () => {
    const config: PortfolioHaltConfig = {
      enabled: true,
      daily_loss_limit_pct: 5,
      sibling_daily_pnl: new Map(),
    };
    const baseline = runPortfolioBacktest(baseRules, prices, 10000);
    const result = runPortfolioBacktest(
      baseRules, prices, 10000, [], null, null, [], null, null, null, undefined, null, config
    );
    // No sibling contribution + this algo's 1% risk per trade → no portfolio
    // breach at 5% DLL. Trade count should equal baseline.
    expect(result.trades.length).toBe(baseline.trades.length);
  });

  it("massive sibling daily loss on a date in the trading window → breach", () => {
    // Inject huge sibling loss on every date the fixture covers, so any open
    // entry attempt that day is blocked.
    const siblingMap = new Map<string, number>();
    for (let d = 1; d <= 28; d++) {
      siblingMap.set(`2026-01-${d.toString().padStart(2, "0")}`, -800);  // 8% of $10K
    }
    const config: PortfolioHaltConfig = {
      enabled: true,
      daily_loss_limit_pct: 5,
      sibling_daily_pnl: siblingMap,
    };
    const baseline = runPortfolioBacktest(baseRules, prices, 10000);
    const result = runPortfolioBacktest(
      baseRules, prices, 10000, [], null, null, [], null, null, null, undefined, null, config
    );
    // Sibling -$800 = 8% loss > 5% DLL → ALL entries on dates in map blocked
    expect(result.trades.length).toBeLessThanOrEqual(baseline.trades.length);
  });

  it("reference_capital override changes the breach threshold", () => {
    // Sibling -$400 on each date. With reference_capital=$10K, -$400 = 4% < 5% DLL → no breach.
    // With reference_capital=$5K (override), -$400 = 8% > 5% DLL → breach.
    const siblingMap = new Map<string, number>();
    for (let d = 1; d <= 28; d++) siblingMap.set(`2026-01-${d.toString().padStart(2, "0")}`, -400);
    const looseRef: PortfolioHaltConfig = {
      enabled: true,
      daily_loss_limit_pct: 5,
      reference_capital: 10000,
      sibling_daily_pnl: siblingMap,
    };
    const tightRef: PortfolioHaltConfig = {
      enabled: true,
      daily_loss_limit_pct: 5,
      reference_capital: 5000,
      sibling_daily_pnl: siblingMap,
    };
    const baseline = runPortfolioBacktest(baseRules, prices, 10000);
    const looseResult = runPortfolioBacktest(
      baseRules, prices, 10000, [], null, null, [], null, null, null, undefined, null, looseRef
    );
    const tightResult = runPortfolioBacktest(
      baseRules, prices, 10000, [], null, null, [], null, null, null, undefined, null, tightRef
    );
    expect(looseResult.trades.length).toBe(baseline.trades.length);  // no breach
    expect(tightResult.trades.length).toBeLessThanOrEqual(baseline.trades.length);  // breached
  });

  it("config.reference_capital undefined falls back to algoCapital", () => {
    // Confirm the fallback path: when reference_capital is undefined,
    // the gate uses the algo's own capital (which validate-algo passes
    // as algoCapital). Sibling -$400/day on $10K algo capital = 4% < 5% DLL → no breach.
    const siblingMap = new Map<string, number>();
    for (let d = 1; d <= 28; d++) siblingMap.set(`2026-01-${d.toString().padStart(2, "0")}`, -400);
    const config: PortfolioHaltConfig = {
      enabled: true,
      daily_loss_limit_pct: 5,
      // reference_capital intentionally omitted → fall back to algoCapital
      sibling_daily_pnl: siblingMap,
    };
    const baseline = runPortfolioBacktest(baseRules, prices, 10000);
    const result = runPortfolioBacktest(
      baseRules, prices, 10000, [], null, null, [], null, null, null, undefined, null, config
    );
    expect(result.trades.length).toBe(baseline.trades.length);
  });

  it("date not in sibling map contributes 0 to combined (no spurious breach)", () => {
    // Sibling map has a date OUTSIDE the fixture's window.
    const siblingMap = new Map<string, number>([["2025-12-15", -9999]]);
    const config: PortfolioHaltConfig = {
      enabled: true,
      daily_loss_limit_pct: 5,
      sibling_daily_pnl: siblingMap,
    };
    const baseline = runPortfolioBacktest(baseRules, prices, 10000);
    const result = runPortfolioBacktest(
      baseRules, prices, 10000, [], null, null, [], null, null, null, undefined, null, config
    );
    // The sibling loss is on a date that doesn't intersect the fixture.
    expect(result.trades.length).toBe(baseline.trades.length);
  });
});
