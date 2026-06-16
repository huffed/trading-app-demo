import { describe, expect, it } from "vitest";
import type { PriceBar } from "@/lib/market-data/types";
import { detectEqualLevels } from "./equal-levels";

const flat = (n: number, base: number = 100): PriceBar[] =>
  Array.from({ length: n }, (_, i) => ({
    date: `f${i}`,
    open: base,
    high: base + 0.5,
    low: base - 0.5,
    close: base,
    volume: 0,
  }));

const swingHighBar = (date: string, base: number, spike: number): PriceBar => ({
  date,
  open: base,
  high: base + spike,
  low: base - 0.5,
  close: base + spike * 0.5,
  volume: 0,
});

const swingLowBar = (date: string, base: number, spike: number): PriceBar => ({
  date,
  open: base,
  high: base + 0.5,
  low: base - spike,
  close: base - spike * 0.5,
  volume: 0,
});

describe("detectEqualLevels", () => {
  it("returns false during warm-up", () => {
    expect(detectEqualLevels(flat(8), 7, "bullish").detected).toBe(false);
  });

  it("returns false when no swings of the required type cluster", () => {
    // Only one swing low across the whole window — can't cluster.
    const bars = flat(60);
    bars[20] = swingLowBar("low", 100, 30);
    expect(detectEqualLevels(bars, 50, "bullish").detected).toBe(false);
  });

  it("detects equal lows (bullish direction) at the same price within tolerance", () => {
    const bars = flat(60, 100);
    // Two swing lows at exactly the same level (80) at indices 15 and 35.
    bars[15] = swingLowBar("L1", 100, 20);
    bars[35] = swingLowBar("L2", 100, 20);
    const r = detectEqualLevels(bars, 50, "bullish", { tolerancePct: 0.5 });
    expect(r.detected).toBe(true);
    expect(r.details?.level_type).toBe("low");
    expect(r.details?.count).toBe(2);
    expect(r.details?.level).toBeCloseTo(80, 1);
    expect(r.details?.swing_indices).toEqual([15, 35]);
  });

  it("detects equal highs (bearish direction)", () => {
    const bars = flat(60, 100);
    bars[15] = swingHighBar("H1", 100, 20);
    bars[35] = swingHighBar("H2", 100, 20);
    const r = detectEqualLevels(bars, 50, "bearish", { tolerancePct: 0.5 });
    expect(r.detected).toBe(true);
    expect(r.details?.level_type).toBe("high");
    expect(r.details?.count).toBe(2);
    expect(r.details?.level).toBeCloseTo(120, 1);
  });

  it("refuses to cluster swings that exceed the tolerance", () => {
    const bars = flat(60, 100);
    // Lows at 80 and 70 — 10 apart on $100 price = 10% diff. With default
    // tolerancePct=0.1 (0.1% = ~0.10) these should NOT cluster.
    bars[15] = swingLowBar("L1", 100, 20);
    bars[35] = swingLowBar("L2", 100, 30); // low = 70
    const r = detectEqualLevels(bars, 50, "bullish");
    expect(r.detected).toBe(false);
  });

  it("picks the LARGEST cluster when multiple candidates exist", () => {
    const bars = flat(80, 100);
    // Three lows at 80 (cluster A), two lows at 60 (cluster B but smaller).
    // Plant A at 15, 35, 55. Plant B at 25, 45.
    bars[15] = swingLowBar("A1", 100, 20);
    bars[35] = swingLowBar("A2", 100, 20);
    bars[55] = swingLowBar("A3", 100, 20);
    bars[25] = swingLowBar("B1", 100, 40);
    bars[45] = swingLowBar("B2", 100, 40);
    // scanWindow=70 so all 5 plants fall in the scan from idx=70 (bottom
    // edge = idx=0). Cluster A then has 3 members and wins over B's 2.
    const r = detectEqualLevels(bars, 70, "bullish", { tolerancePct: 0.5, scanWindow: 70 });
    expect(r.detected).toBe(true);
    expect(r.details?.count).toBe(3);
    expect(r.details?.level).toBeCloseTo(80, 1);
  });

  it("respects scanWindow — excludes too-old swings", () => {
    const bars = flat(100, 100);
    bars[10] = swingLowBar("L1", 100, 20);
    bars[20] = swingLowBar("L2", 100, 20);
    // Both lows are outside a 30-bar scan window from idx=80.
    const r = detectEqualLevels(bars, 80, "bullish", { scanWindow: 30, tolerancePct: 0.5 });
    expect(r.detected).toBe(false);
  });

  it("respects minCount — requires N qualifying swings", () => {
    const bars = flat(60, 100);
    bars[15] = swingLowBar("L1", 100, 20);
    bars[35] = swingLowBar("L2", 100, 20);
    // Two lows present; minCount=3 should refuse.
    const r = detectEqualLevels(bars, 50, "bullish", { tolerancePct: 0.5, minCount: 3 });
    expect(r.detected).toBe(false);
  });

  it("tolerance scales with anchor price level", () => {
    // At anchor price 4000, 0.1% tolerance = $4. Two swings at 4000 and
    // 4003 should cluster (within $4). At anchor 100, 0.1% = $0.10 only.
    const bars = flat(60, 4000);
    bars[15] = swingLowBar("L1", 4000, 100); // low = 3900
    bars[35] = swingLowBar("L2", 4000, 100 - 3); // low = 3903 → close enough at 0.1%
    const r = detectEqualLevels(bars, 50, "bullish");
    expect(r.detected).toBe(true);
    expect(r.details?.count).toBe(2);
  });

  it("returns false when minCount < 2 (defensive — minimum 2 required)", () => {
    const bars = flat(60);
    bars[15] = swingLowBar("L1", 100, 20);
    const r = detectEqualLevels(bars, 50, "bullish", { minCount: 1 });
    expect(r.detected).toBe(false);
  });
});
