import { describe, expect, it } from "vitest";
import type { PriceBar } from "@/lib/market-data/types";
import { detectOte } from "./ote";
import { detectSwingPoints } from "./swing-points";

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

const closeBar = (
  date: string,
  close: number,
  baseHigh: number,
  baseLow: number
): PriceBar => ({
  date,
  open: close,
  high: baseHigh,
  low: baseLow,
  close,
  volume: 0,
});

describe("detectOte", () => {
  it("returns false during warm-up", () => {
    expect(detectOte(flat(5), 4, 5).detected).toBe(false);
  });

  it("returns false when fewer than 2 swings exist", () => {
    expect(detectOte(flat(50), 30, 5).detected).toBe(false);
  });

  it("detects bullish OTE — close inside [62%,79%] retrace of a bullish leg", () => {
    // Bullish leg = swing low → swing high. Low at idx 6 (low=80), high
    // at idx 18 (high=140). range=60. OTE = [140 - 0.79*60, 140 - 0.62*60]
    // = [92.6, 102.8]. Close at 100 lands inside.
    const bars: PriceBar[] = [
      ...flat(6, 100),
      swingLowBar("low", 100, 20),   // idx 6 — low=80
      ...flat(11, 100),
      swingHighBar("high", 100, 40), // idx 18 — high=140
      ...flat(7, 100),               // padding for swing confirmation
    ];
    const swings = detectSwingPoints(bars, 5);
    expect(swings.find((s) => s.type === "low")?.price).toBe(80);
    expect(swings.find((s) => s.type === "high")?.price).toBe(140);

    bars.push(closeBar("retrace", 100, 105, 95));
    const idx = bars.length - 1;
    const v = detectOte(bars, idx, 5);
    expect(v.detected).toBe(true);
    expect(v.details?.direction).toBe("bullish");
    expect(v.details?.leg_low).toBe(80);
    expect(v.details?.leg_high).toBe(140);
    expect(v.details?.ote_bottom).toBeCloseTo(92.6, 5);
    expect(v.details?.ote_top).toBeCloseTo(102.8, 5);
    // retracement_pct = (140 - 100) / 60 * 100 = 66.67%
    expect(v.details?.retracement_pct).toBeCloseTo(66.67, 1);
  });

  it("detects bearish OTE — close inside [62%,79%] retrace of a bearish leg", () => {
    // Bearish leg = swing high → swing low. High at idx 6, low at idx 18.
    // Same range=60 (high=140, low=80). OTE = [80+0.62*60, 80+0.79*60]
    // = [117.2, 127.4]. Close at 120 lands inside.
    const bars: PriceBar[] = [
      ...flat(6, 100),
      swingHighBar("high", 100, 40), // idx 6 — high=140
      ...flat(11, 100),
      swingLowBar("low", 100, 20),   // idx 18 — low=80
      ...flat(7, 100),
    ];
    bars.push(closeBar("retrace", 120, 125, 118));
    const idx = bars.length - 1;
    const v = detectOte(bars, idx, 5);
    expect(v.detected).toBe(true);
    expect(v.details?.direction).toBe("bearish");
    expect(v.details?.leg_low).toBe(80);
    expect(v.details?.leg_high).toBe(140);
    expect(v.details?.ote_bottom).toBeCloseTo(117.2, 5);
    expect(v.details?.ote_top).toBeCloseTo(127.4, 5);
    expect(v.details?.retracement_pct).toBeCloseTo(66.67, 1);
  });

  it("returns false when close is shallower than 62% retrace", () => {
    // Bullish leg low=80 high=140. Shallow close at 130 (only ~17% retraced).
    const bars: PriceBar[] = [
      ...flat(6, 100),
      swingLowBar("low", 100, 20),
      ...flat(11, 100),
      swingHighBar("high", 100, 40),
      ...flat(7, 100),
    ];
    bars.push(closeBar("shallow", 130, 135, 128));
    const idx = bars.length - 1;
    expect(detectOte(bars, idx, 5).detected).toBe(false);
  });

  it("returns false when close is deeper than 79% (failing leg)", () => {
    // Bullish leg low=80 high=140. Close at 85 — almost back to leg origin.
    const bars: PriceBar[] = [
      ...flat(6, 100),
      swingLowBar("low", 100, 20),
      ...flat(11, 100),
      swingHighBar("high", 100, 40),
      ...flat(7, 100),
    ];
    bars.push(closeBar("deep", 85, 100, 82));
    const idx = bars.length - 1;
    expect(detectOte(bars, idx, 5).detected).toBe(false);
  });

  it("custom fib bounds widen the zone", () => {
    // Bullish leg low=80 high=140 (range=60). Default OTE = [92.6, 102.8].
    // With fib=0.5..0.9 → [140-54, 140-30] = [86, 110]. Close at 108 → inside.
    const bars: PriceBar[] = [
      ...flat(6, 100),
      swingLowBar("low", 100, 20),
      ...flat(11, 100),
      swingHighBar("high", 100, 40),
      ...flat(7, 100),
    ];
    bars.push(closeBar("widezone", 108, 112, 107));
    const idx = bars.length - 1;
    expect(detectOte(bars, idx, 5, 0.5, 0.9).detected).toBe(true);
    expect(detectOte(bars, idx, 5).detected).toBe(false); // default zone rejects 108
  });

  it("rejects invalid fib bounds", () => {
    const bars = flat(50);
    expect(detectOte(bars, 30, 5, 0.8, 0.5).detected).toBe(false);
    expect(detectOte(bars, 30, 5, 0, 0.5).detected).toBe(false);
    expect(detectOte(bars, 30, 5, 0.5, 1).detected).toBe(false);
  });
});
