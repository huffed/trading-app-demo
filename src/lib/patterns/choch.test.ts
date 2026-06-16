import { describe, expect, it } from "vitest";
import type { PriceBar } from "@/lib/market-data/types";
import { detectChoch } from "./choch";
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

/** A single-bar swing high: high spikes by `spike`; low stays in line
 *  with the surrounding base level so the bar is NOT also a swing low. */
const swingHighBar = (date: string, base: number, spike: number): PriceBar => ({
  date,
  open: base,
  high: base + spike,
  low: base - 0.5,
  close: base + spike * 0.5,
  volume: 0,
});

/** A single-bar swing low: low spikes down. High stays in line. */
const swingLowBar = (date: string, base: number, spike: number): PriceBar => ({
  date,
  open: base,
  high: base + 0.5,
  low: base - spike,
  close: base - spike * 0.5,
  volume: 0,
});

/** A normal close bar (no swing) at a specific close, surrounded by
 *  pre-defined high/low so it can't be a swing. */
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

describe("detectChoch", () => {
  it("returns false during warm-up (idx < 2*lookback+1)", () => {
    const bars = flat(5);
    expect(detectChoch(bars, 4, 5).detected).toBe(false);
  });

  it("returns false on a series with no swings", () => {
    const bars = flat(50);
    expect(detectChoch(bars, 30, 5).detected).toBe(false);
  });

  it("detects bearish ChoCh in a confirmed uptrend (HH+HL → close < recent low)", () => {
    // Construct an HH+HL trend, then a bar that closes below the most
    // recent swing low. Lookback=5 → need 5 flat bars between swings
    // so each swing is unique.
    const bars: PriceBar[] = [
      ...flat(6, 100), // 0-5
      swingLowBar("low1", 100, 5), // idx 6 — low=95
      ...flat(11, 100), // 7-17
      swingHighBar("high1", 100, 4), // idx 18 — high=104
      ...flat(11, 100), // 19-29
      swingLowBar("low2", 100, 3), // idx 30 — low=97 (higher than low1=95 → HL ascending)
      ...flat(11, 100), // 31-41
      swingHighBar("high2", 100, 6), // idx 42 — high=106 (higher than high1=104 → HH ascending)
      ...flat(7, 100), // 43-49 — padding for swing confirmation (lookback=5)
    ];
    // Sanity: verify the swings we expect exist.
    const swings = detectSwingPoints(bars, 5);
    const highs = swings.filter((s) => s.type === "high").map((s) => s.price);
    const lows = swings.filter((s) => s.type === "low").map((s) => s.price);
    expect(highs).toEqual([104, 106]);
    expect(lows).toEqual([95, 97]);

    // ChoCh trigger: bar closes below 97 (most recent swing low).
    bars.push(closeBar("break", 90, 102, 88));
    const idx = bars.length - 1;
    const v = detectChoch(bars, idx, 5);
    expect(v.detected).toBe(true);
    expect(v.details?.direction).toBe("bearish");
    expect(v.details?.prevailing_trend).toBe("uptrend");
    expect(v.details?.broken_level).toBe(97);
    expect(v.details?.break_close).toBe(90);
  });

  it("detects bullish ChoCh in a confirmed downtrend (LH+LL → close > recent high)", () => {
    const bars: PriceBar[] = [
      ...flat(6, 100),
      swingHighBar("high1", 100, 6), // 106
      ...flat(11, 100),
      swingLowBar("low1", 100, 3),   // 97
      ...flat(11, 100),
      swingHighBar("high2", 100, 4), // 104 (lower than 106 → LH)
      ...flat(11, 100),
      swingLowBar("low2", 100, 5),   // 95 (lower than 97 → LL)
      ...flat(7, 100),
    ];
    const swings = detectSwingPoints(bars, 5);
    expect(swings.filter((s) => s.type === "high").map((s) => s.price)).toEqual([106, 104]);
    expect(swings.filter((s) => s.type === "low").map((s) => s.price)).toEqual([97, 95]);

    // Break bar: close above 104 (most recent swing high).
    bars.push(closeBar("break", 110, 112, 99));
    const idx = bars.length - 1;
    const v = detectChoch(bars, idx, 5);
    expect(v.detected).toBe(true);
    expect(v.details?.direction).toBe("bullish");
    expect(v.details?.prevailing_trend).toBe("downtrend");
    expect(v.details?.broken_level).toBe(104);
  });

  it("returns false when trend is mixed (highs descending, lows ascending)", () => {
    const bars: PriceBar[] = [
      ...flat(6, 100),
      swingHighBar("h1", 100, 6),    // 106
      ...flat(11, 100),
      swingLowBar("l1", 100, 5),     // 95
      ...flat(11, 100),
      swingHighBar("h2", 100, 4),    // 104 (descending)
      ...flat(11, 100),
      swingLowBar("l2", 100, 3),     // 97 (ascending) — mixed!
      ...flat(7, 100),
    ];
    bars.push(closeBar("break", 80, 102, 78));
    const idx = bars.length - 1;
    expect(detectChoch(bars, idx, 5).detected).toBe(false);
  });

  it("does not fire on equal-close (must be strictly past the level)", () => {
    // Reuse uptrend fixture; close lands exactly on the swing low.
    const bars: PriceBar[] = [
      ...flat(6, 100),
      swingLowBar("low1", 100, 5),
      ...flat(11, 100),
      swingHighBar("high1", 100, 4),
      ...flat(11, 100),
      swingLowBar("low2", 100, 3),
      ...flat(11, 100),
      swingHighBar("high2", 100, 6),
      ...flat(7, 100),
    ];
    // most recent swing low = 97 (low2)
    bars.push(closeBar("touch", 97, 102, 96));
    const idx = bars.length - 1;
    expect(detectChoch(bars, idx, 5).detected).toBe(false);
  });
});
