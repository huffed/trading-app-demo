import { describe, expect, it } from "vitest";
import { runPortfolioBacktest, tradesAsSiblingWindows, type SiblingTradeWindow } from "./portfolio-backtest";
import type { AlgorithmRules } from "@/types/algorithm";
import type { PriceBar } from "./types";

function bar(date: string, o: number, h: number, l: number, c: number): PriceBar {
  return { date, open: o, high: h, low: l, close: c, volume: 0 };
}

// Minimal long-only rule: RSI < 30 → enter, RSI > 70 → exit
const rules: AlgorithmRules = {
  asset_class: "commodity",
  side: "long",
  timeframe: "4h",
  entry_conditions: [{ type: "technical", indicator: "rsi", operator: "less_than", value: 30, timeframe: "4h" }],
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

/** Synthetic 30-bar OHLCV with an oversold dip → recovery sequence.
 *  Should produce 1 entry around bar 15 when RSI dips below 30. */
function makeOversoldRecoveryFixture(): PriceBar[] {
  const bars: PriceBar[] = [];
  let price = 100;
  // 10 bars: gentle uptrend
  for (let i = 0; i < 10; i++) {
    bars.push(bar(`2026-01-${(i + 1).toString().padStart(2, "0")}T04:00:00Z`, price, price + 1, price - 0.5, price + 0.8));
    price += 0.8;
  }
  // 8 bars: steep crash (drives RSI < 30)
  for (let i = 10; i < 18; i++) {
    bars.push(bar(`2026-01-${(i + 1).toString().padStart(2, "0")}T04:00:00Z`, price, price + 0.2, price - 2.5, price - 2));
    price -= 2;
  }
  // 12 bars: recovery
  for (let i = 18; i < 30; i++) {
    bars.push(bar(`2026-01-${(i + 1).toString().padStart(2, "0")}T04:00:00Z`, price, price + 1.5, price - 0.3, price + 1.2));
    price += 1.2;
  }
  return bars;
}

describe("portfolio-backtest direction conflict simulation (Phase B.1)", () => {
  const bars = makeOversoldRecoveryFixture();
  const prices = new Map([["XAU/USD", bars]]);

  it("baseline: no siblings means no direction-conflict blocking", () => {
    const result = runPortfolioBacktest(rules, prices, 10000);
    // B.1.10: assert fixture actually produces trades. Without this,
    // downstream tests' silent-skip patterns become invisible no-ops.
    expect(result.trades.length).toBeGreaterThan(0);
  });

  it("sibling SHORT on same ticker BLOCKS the LONG entry when overlapping", () => {
    const baselineResult = runPortfolioBacktest(rules, prices, 10000);
    // B.1.10: fixture MUST produce trades or this test is meaningless.
    expect(baselineResult.trades.length).toBeGreaterThan(0);
    // Sibling holds SHORT XAU/USD covering the entire backtest window.
    const blockingSibling: SiblingTradeWindow[] = [
      { ticker: "XAU/USD", side: "short", entry_date: "2026-01-01T00:00:00Z", exit_date: "2026-02-01T00:00:00Z" },
    ];
    const conflictResult = runPortfolioBacktest(rules, prices, 10000, [], null, null, blockingSibling);
    // B.1.10: strict < (not <=) so a no-op gate would fail the test.
    expect(conflictResult.trades.length).toBeLessThan(baselineResult.trades.length);
  });

  it("sibling LONG on same ticker DOES NOT block the LONG entry (same direction = OK)", () => {
    const baselineResult = runPortfolioBacktest(rules, prices, 10000);
    expect(baselineResult.trades.length).toBeGreaterThan(0);
    const sameSideSibling: SiblingTradeWindow[] = [
      { ticker: "XAU/USD", side: "long", entry_date: "2026-01-01T00:00:00Z", exit_date: "2026-02-01T00:00:00Z" },
    ];
    const sameDirResult = runPortfolioBacktest(rules, prices, 10000, [], null, null, sameSideSibling);
    expect(sameDirResult.trades.length).toBe(baselineResult.trades.length);
  });

  it("sibling SHORT on DIFFERENT ticker does NOT block (cross-instrument is fine)", () => {
    const baselineResult = runPortfolioBacktest(rules, prices, 10000);
    expect(baselineResult.trades.length).toBeGreaterThan(0);
    const diffTickerSibling: SiblingTradeWindow[] = [
      { ticker: "USD/JPY", side: "short", entry_date: "2026-01-01T00:00:00Z", exit_date: "2026-02-01T00:00:00Z" },
    ];
    const diffResult = runPortfolioBacktest(rules, prices, 10000, [], null, null, diffTickerSibling);
    expect(diffResult.trades.length).toBe(baselineResult.trades.length);
  });

  it("sibling SHORT outside the entry window does NOT block (date check)", () => {
    const baselineResult = runPortfolioBacktest(rules, prices, 10000);
    expect(baselineResult.trades.length).toBeGreaterThan(0);
    // Sibling closed before fixture starts → no block
    const outsideSibling: SiblingTradeWindow[] = [
      { ticker: "XAU/USD", side: "short", entry_date: "2025-01-01T00:00:00Z", exit_date: "2025-12-01T00:00:00Z" },
    ];
    const outsideResult = runPortfolioBacktest(rules, prices, 10000, [], null, null, outsideSibling);
    expect(outsideResult.trades.length).toBe(baselineResult.trades.length);
  });
});

describe("tradesAsSiblingWindows", () => {
  it("converts trades with ticker + side into sibling windows", () => {
    const trades = [
      { ticker: "XAU/USD", side: "long" as const, entry_date: "2026-01-01", exit_date: "2026-01-05", entry_price: 100, exit_price: 105, pnl: 5 },
      { ticker: "USD/JPY", side: "short" as const, entry_date: "2026-01-02", exit_date: "2026-01-06", entry_price: 150, exit_price: 148, pnl: 2 },
    ];
    const windows = tradesAsSiblingWindows(trades);
    expect(windows).toHaveLength(2);
    expect(windows[0]).toEqual({ ticker: "XAU/USD", side: "long", entry_date: "2026-01-01", exit_date: "2026-01-05" });
    expect(windows[1]).toEqual({ ticker: "USD/JPY", side: "short", entry_date: "2026-01-02", exit_date: "2026-01-06" });
  });

  it("skips trades missing ticker or side", () => {
    const trades = [
      { ticker: "XAU/USD", side: "long" as const, entry_date: "2026-01-01", exit_date: "2026-01-05", entry_price: 100, exit_price: 105, pnl: 5 },
      // missing ticker (legacy single-ticker backtest)
      { side: "short" as const, entry_date: "2026-01-02", exit_date: "2026-01-06", entry_price: 150, exit_price: 148, pnl: 2 },
    ];
    const windows = tradesAsSiblingWindows(trades);
    expect(windows).toHaveLength(1);
    expect(windows[0].ticker).toBe("XAU/USD");
  });
});
