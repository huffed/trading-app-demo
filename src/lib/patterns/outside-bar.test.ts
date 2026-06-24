import { describe, expect, it } from "vitest";
import type { PriceBar } from "@/lib/market-data/types";
import { detectOutsideBar } from "./outside-bar";

function bar(open: number, high: number, low: number, close: number): PriceBar {
  return { date: "2024-01-01", open, high, low, close, volume: 0 };
}

describe("detectOutsideBar", () => {
  it("returns false for idx=0 (no previous bar)", () => {
    const bars = [bar(100, 110, 90, 105)];
    expect(detectOutsideBar(bars, 0).detected).toBe(false);
  });

  it("detects bullish outside bar (cur range engulfs prev, cur closes up)", () => {
    const bars = [
      bar(100, 110, 95, 105), // previous narrow range
      bar(98, 120, 90, 118), // current engulfs + closes bullish
    ];
    const r = detectOutsideBar(bars, 1);
    expect(r.detected).toBe(true);
    expect(r.details?.direction).toBe("bullish");
    expect(r.details?.cur_high).toBe(120);
    expect(r.details?.cur_low).toBe(90);
    expect(r.details?.range_expansion_ratio).toBe(2);
  });

  it("detects bearish outside bar (cur range engulfs prev, cur closes down)", () => {
    const bars = [
      bar(105, 110, 100, 108), // previous
      bar(112, 115, 90, 95), // current engulfs + closes bearish
    ];
    const r = detectOutsideBar(bars, 1);
    expect(r.detected).toBe(true);
    expect(r.details?.direction).toBe("bearish");
  });

  it("returns false when high equals previous high (strict engulf)", () => {
    const bars = [
      bar(100, 110, 95, 105),
      bar(98, 110, 90, 108), // high equal — not strictly engulfing
    ];
    expect(detectOutsideBar(bars, 1).detected).toBe(false);
  });

  it("returns false when current bar closes as doji (ambiguous direction)", () => {
    const bars = [
      bar(105, 110, 100, 108),
      bar(102, 115, 90, 102), // engulfs but close=open
    ];
    expect(detectOutsideBar(bars, 1).detected).toBe(false);
  });

  it("range_expansion_ratio captures relative bar size", () => {
    const bars = [
      bar(100, 105, 95, 102), // prev range = 10
      bar(98, 130, 70, 125), // cur range = 60 → 6× expansion
    ];
    const r = detectOutsideBar(bars, 1);
    expect(r.details?.range_expansion_ratio).toBe(6);
  });

  it("idx out of range returns false", () => {
    const bars = [bar(100, 110, 90, 105)];
    expect(detectOutsideBar(bars, 99).detected).toBe(false);
  });
});
