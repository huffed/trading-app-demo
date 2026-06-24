import { describe, expect, it } from "vitest";
import type { PriceBar } from "@/lib/market-data/types";
import { detectInsideBar } from "./inside-bar";

function bar(open: number, high: number, low: number, close: number): PriceBar {
  return { date: "2024-01-01", open, high, low, close, volume: 0 };
}

describe("detectInsideBar", () => {
  it("returns false for idx=0 (no previous bar)", () => {
    const bars = [bar(100, 110, 90, 105)];
    expect(detectInsideBar(bars, 0).detected).toBe(false);
  });

  it("detects bullish inside bar (previous bar bullish, current inside)", () => {
    const bars = [
      bar(100, 120, 90, 115), // previous bullish, big range
      bar(108, 115, 100, 110), // current inside
    ];
    const r = detectInsideBar(bars, 1);
    expect(r.detected).toBe(true);
    expect(r.details?.direction).toBe("bullish");
    expect(r.details?.prev_high).toBe(120);
    expect(r.details?.prev_low).toBe(90);
  });

  it("detects bearish inside bar (previous bar bearish, current inside)", () => {
    const bars = [
      bar(120, 130, 100, 105), // previous bearish, big range
      bar(110, 125, 105, 108), // current inside
    ];
    const r = detectInsideBar(bars, 1);
    expect(r.detected).toBe(true);
    expect(r.details?.direction).toBe("bearish");
  });

  it("returns false when current bar's high equals previous bar's high (strict containment)", () => {
    const bars = [
      bar(100, 120, 90, 115),
      bar(108, 120, 100, 110), // equal high — not strictly inside
    ];
    expect(detectInsideBar(bars, 1).detected).toBe(false);
  });

  it("returns false when previous bar was a doji (ambiguous direction)", () => {
    const bars = [
      bar(100, 110, 90, 100), // doji previous (open=close)
      bar(102, 108, 95, 105), // inside
    ];
    expect(detectInsideBar(bars, 1).detected).toBe(false);
  });

  it("returns false when current bar breaks above previous bar's high", () => {
    const bars = [
      bar(100, 120, 90, 115),
      bar(108, 125, 100, 122), // current breaks above
    ];
    expect(detectInsideBar(bars, 1).detected).toBe(false);
  });

  it("idx out of range returns false", () => {
    const bars = [bar(100, 110, 90, 105), bar(102, 108, 95, 105)];
    expect(detectInsideBar(bars, 99).detected).toBe(false);
    expect(detectInsideBar(bars, -1).detected).toBe(false);
  });
});
