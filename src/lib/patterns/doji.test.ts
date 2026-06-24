import { describe, expect, it } from "vitest";
import type { PriceBar } from "@/lib/market-data/types";
import { detectDoji } from "./doji";

function bar(open: number, high: number, low: number, close: number): PriceBar {
  return { date: "2024-01-01", open, high, low, close, volume: 0 };
}

describe("detectDoji", () => {
  it("returns false for zero-range bars (degenerate / stale)", () => {
    const bars = [bar(100, 100, 100, 100)];
    expect(detectDoji(bars, 0).detected).toBe(false);
  });

  it("detects classic doji (body ≤ 10% of range)", () => {
    const bars = [bar(100, 110, 90, 100.5)]; // body = 0.5, range = 20 → 2.5% ratio
    const r = detectDoji(bars, 0);
    expect(r.detected).toBe(true);
    expect(r.details?.body_to_range_ratio).toBeLessThan(0.1);
  });

  it("returns false when body exceeds threshold", () => {
    const bars = [bar(100, 110, 90, 108)]; // body = 8, range = 20 → 40% ratio
    expect(detectDoji(bars, 0).detected).toBe(false);
  });

  it("classifies dragonfly doji (lower wick dominates)", () => {
    const bars = [bar(108, 110, 90, 108.5)]; // small body up top, long lower wick
    const r = detectDoji(bars, 0);
    expect(r.detected).toBe(true);
    expect(r.details?.subtype).toBe("dragonfly");
  });

  it("classifies gravestone doji (upper wick dominates)", () => {
    const bars = [bar(92, 110, 90, 91.5)]; // small body at bottom, long upper wick
    const r = detectDoji(bars, 0);
    expect(r.detected).toBe(true);
    expect(r.details?.subtype).toBe("gravestone");
  });

  it("classifies long-legged doji (both wicks significant)", () => {
    const bars = [bar(100, 110, 90, 100.5)]; // body in middle, wicks both ≥30% of range
    const r = detectDoji(bars, 0);
    expect(r.detected).toBe(true);
    expect(r.details?.subtype).toBe("long_legged");
  });

  it("respects custom body_to_range_ratio threshold", () => {
    const bars = [bar(100, 110, 90, 101)]; // body=1, range=20 → 5% ratio
    expect(detectDoji(bars, 0, { body_to_range_ratio: 0.1 }).detected).toBe(true);
    expect(detectDoji(bars, 0, { body_to_range_ratio: 0.04 }).detected).toBe(false);
  });

  it("idx out of range returns false", () => {
    const bars = [bar(100, 110, 90, 100)];
    expect(detectDoji(bars, 99).detected).toBe(false);
    expect(detectDoji(bars, -1).detected).toBe(false);
  });
});
