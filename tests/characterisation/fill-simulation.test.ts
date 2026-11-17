/**
 * Characterisation — how the backtester fills exits (prop-firm-backtest.ts
 * `pickBacktestExitPrice` + `applySlippage`). Live paper fills are a polled
 * quote with no friction (docs/CODE_QUALITY.md §3.2); the backtest fills at
 * the level ± slippage, at the OPEN when a bar gaps through the stop, and the
 * stop wins when SL and TP both sit inside one bar.
 */
import { describe, expect, it } from "vitest";
import {
  applySlippage,
  pickBacktestExitPrice,
  type SimConfig,
} from "@/lib/market-data/prop-firm-backtest";

const SLIPPAGE_BPS = 0.5;
const cfg: SimConfig = {
  slippageBps: SLIPPAGE_BPS,
  spreadBps: 0.4,
  commissionPct: 0,
  commissionPerLot: 0,
  maxPos: 1,
  posSize: 0.0042,
  stopLoss: { type: "swing_anchor", value: 0.1, lookback: 3 },
  takeProfit: { type: "rr_multiple", value: 3 },
};
const longPos = { entryPrice: 4000, side: "long" as const, slDistance: 50, tpDistance: 150 }; // SL 3950, TP 4150
const shortPos = { entryPrice: 4000, side: "short" as const, slDistance: 50, tpDistance: 150 }; // SL 4050, TP 3850
const sell = (price: number) => applySlippage(price, SLIPPAGE_BPS, false);
const buy = (price: number) => applySlippage(price, SLIPPAGE_BPS, true);

describe("applySlippage", () => {
  it("0.5 bps on $4,000 is $0.20, against the trader", () => {
    expect(applySlippage(4000, 0.5, true)).toBeCloseTo(4000.2, 10);
    expect(applySlippage(4000, 0.5, false)).toBeCloseTo(3999.8, 10);
  });
});

describe("long position exits", () => {
  it("a bar that opens through the stop fills at the OPEN, not the stop (gap)", () => {
    const d = pickBacktestExitPrice(
      longPos,
      { open: 3900, high: 3950, low: 3880 },
      3920,
      cfg,
      false
    );
    expect(d).toEqual({ price: sell(3900), reason: "stop_loss_hit" });
  });

  it("an intrabar stop fills at the stop level minus slippage", () => {
    const d = pickBacktestExitPrice(
      longPos,
      { open: 3990, high: 4010, low: 3940 },
      3960,
      cfg,
      false
    );
    expect(d).toEqual({ price: sell(3950), reason: "stop_loss_hit" });
  });

  it("a take-profit fills at the level minus slippage", () => {
    const d = pickBacktestExitPrice(
      longPos,
      { open: 4010, high: 4160, low: 4005 },
      4120,
      cfg,
      false
    );
    expect(d).toEqual({ price: sell(4150), reason: "take_profit_hit" });
  });

  it("stop wins when SL and TP are both inside the bar", () => {
    const d = pickBacktestExitPrice(
      longPos,
      { open: 4000, high: 4160, low: 3940 },
      4100,
      cfg,
      false
    );
    expect(d?.reason).toBe("stop_loss_hit");
  });

  it("a signal/stagnant exit fills at the close minus slippage", () => {
    const d = pickBacktestExitPrice(
      longPos,
      { open: 4005, high: 4020, low: 3990 },
      4010,
      cfg,
      true
    );
    expect(d).toEqual({ price: sell(4010), reason: "signal_exit" });
  });

  it("no level touched and no signal → stays open", () => {
    expect(
      pickBacktestExitPrice(longPos, { open: 4005, high: 4020, low: 3990 }, 4010, cfg, false)
    ).toBeNull();
  });
});

describe("short position exits (mirror)", () => {
  it("gap above the stop fills at the open, on the buy side", () => {
    const d = pickBacktestExitPrice(
      shortPos,
      { open: 4060, high: 4080, low: 4055 },
      4070,
      cfg,
      false
    );
    expect(d).toEqual({ price: buy(4060), reason: "stop_loss_hit" });
  });

  it("take-profit at the level plus slippage", () => {
    const d = pickBacktestExitPrice(
      shortPos,
      { open: 3990, high: 3995, low: 3840 },
      3860,
      cfg,
      false
    );
    expect(d).toEqual({ price: buy(3850), reason: "take_profit_hit" });
  });
});
