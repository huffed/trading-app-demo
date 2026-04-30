import { describe, expect, it } from "vitest";
import type { PriceBar } from "@/lib/market-data/types";
import { detectAsianRangeBreak } from "./asian-range-break";

function bar(date: string, o: number, h: number, l: number, c: number): PriceBar {
  return { date, open: o, high: h, low: l, close: c, volume: 0 };
}

/** 7 hourly Asian session bars (UTC 00:00-06:00) on 2026-04-30 followed
 *  by London-session bars at 07:00, 08:00. Asian range = 1.0-2.0. */
function buildBars(): PriceBar[] {
  return [
    bar("2026-04-30T00:00:00Z", 1.5, 1.6, 1.4, 1.5),
    bar("2026-04-30T01:00:00Z", 1.5, 1.7, 1.4, 1.6),
    bar("2026-04-30T02:00:00Z", 1.6, 1.8, 1.5, 1.7),
    bar("2026-04-30T03:00:00Z", 1.7, 2.0, 1.5, 1.8), // range high = 2.0
    bar("2026-04-30T04:00:00Z", 1.8, 1.9, 1.0, 1.5), // range low = 1.0
    bar("2026-04-30T05:00:00Z", 1.5, 1.7, 1.3, 1.6),
    bar("2026-04-30T06:00:00Z", 1.6, 1.8, 1.4, 1.7),
    // London session — possible breakout bars
  ];
}

describe("detectAsianRangeBreak", () => {
  it("fires bullish when London bar wicks AND closes above range high", () => {
    const bars = [
      ...buildBars(),
      bar("2026-04-30T07:00:00Z", 1.7, 2.2, 1.7, 2.1), // breaks 2.0 high, closes above
    ];
    const r = detectAsianRangeBreak(bars, bars.length - 1);
    expect(r.detected).toBe(true);
    expect(r.details?.direction).toBe("bullish");
    expect(r.details?.range_high).toBeCloseTo(2.0, 2);
    expect(r.details?.range_low).toBeCloseTo(1.0, 2);
    expect(r.details?.range_width).toBeCloseTo(1.0, 2);
  });

  it("fires bearish when London bar wicks AND closes below range low", () => {
    const bars = [
      ...buildBars(),
      bar("2026-04-30T07:00:00Z", 1.5, 1.5, 0.8, 0.9), // breaks 1.0 low, closes below
    ];
    const r = detectAsianRangeBreak(bars, bars.length - 1);
    expect(r.detected).toBe(true);
    expect(r.details?.direction).toBe("bearish");
    expect(r.details?.break_price).toBeCloseTo(0.9, 2);
  });

  it("does NOT fire when only the wick pierces (close inside range)", () => {
    const bars = [
      ...buildBars(),
      bar("2026-04-30T07:00:00Z", 1.7, 2.5, 1.6, 1.9), // wicks above 2.0 but closes 1.9
    ];
    expect(detectAsianRangeBreak(bars, bars.length - 1).detected).toBe(false);
  });

  it("does not fire during Asian session itself", () => {
    const bars = buildBars();
    expect(detectAsianRangeBreak(bars, 3).detected).toBe(false);
  });

  it("returns false when no Asian-session bars exist for the same UTC date", () => {
    const bars = [
      bar("2026-04-29T20:00:00Z", 1.0, 1.1, 0.9, 1.0),
      bar("2026-04-30T07:00:00Z", 1.0, 2.5, 1.0, 2.4), // no Asian bars on 30th
    ];
    expect(detectAsianRangeBreak(bars, bars.length - 1).detected).toBe(false);
  });

  it("does not fire when bar stays inside the range", () => {
    const bars = [
      ...buildBars(),
      bar("2026-04-30T07:00:00Z", 1.5, 1.8, 1.3, 1.6), // entirely inside [1.0, 2.0]
    ];
    expect(detectAsianRangeBreak(bars, bars.length - 1).detected).toBe(false);
  });
});
