/**
 * H.6 — Regime classifier tests. Locks: tercile boundaries (33.33 /
 * 66.67 pct), insufficient-lookback null return, classifyAllBars
 * shape (nulls before REGIME_LOOKBACK_BARS).
 */
import { describe, expect, it } from "vitest";
import {
  classifyAllBars,
  classifyRegime,
  HIGH_VOL_LOWER_PCT,
  LOW_VOL_UPPER_PCT,
  REGIMES,
  REGIME_LOOKBACK_BARS,
  type Regime,
} from "./regime-classifier";
import type { PriceBar } from "@/lib/market-data/types";

/** Build synthetic bars where bar i has range = baseRange + offset(i),
 *  giving a deterministic ATR profile that lets us validate the
 *  classifier output against manual percentile expectations. */
function syntheticBars(n: number, rangeFn: (i: number) => number): PriceBar[] {
  const bars: PriceBar[] = [];
  for (let i = 0; i < n; i++) {
    const range = rangeFn(i);
    bars.push({
      date: new Date(1577836800000 + i * 4 * 3_600_000).toISOString(),
      open: 100,
      high: 100 + range,
      low: 100 - range,
      close: 100,
      volume: 0,
    });
  }
  return bars;
}

describe("regime classifier — pure math", () => {
  it("constants are pre-registered: 33.33 / 66.67", () => {
    expect(LOW_VOL_UPPER_PCT).toBe(33.33);
    expect(HIGH_VOL_LOWER_PCT).toBe(66.67);
    expect(REGIME_LOOKBACK_BARS).toBe(200);
  });

  it("REGIMES = ['low_vol', 'medium_vol', 'high_vol']", () => {
    expect(REGIMES).toEqual(["low_vol", "medium_vol", "high_vol"]);
  });

  it("returns null when idx < REGIME_LOOKBACK_BARS (insufficient lookback)", () => {
    const bars = syntheticBars(220, () => 1);
    expect(classifyRegime(bars, 50)).toBeNull();
    expect(classifyRegime(bars, 199)).toBeNull();
    expect(classifyRegime(bars, 200)).not.toBeNull();
  });

  it("returns 'low_vol' when current ATR is in the lowest tercile of the 200-bar window", () => {
    // Build bars where the LAST few have a SMALLER range than the prior bars
    // Bars 0..199 have range 10; bars 200..205 have range 0.5 (much lower)
    const bars = syntheticBars(210, (i) => (i < 200 ? 10 : 0.5));
    const r = classifyRegime(bars, 209);
    expect(r).toBe("low_vol");
  });

  it("returns 'high_vol' when current ATR is in the top tercile of the 200-bar window", () => {
    // Bars 0..199 have range 1; bars 200..205 have range 50
    const bars = syntheticBars(210, (i) => (i < 200 ? 1 : 50));
    const r = classifyRegime(bars, 209);
    expect(r).toBe("high_vol");
  });

  it("medium_vol is reachable: classifyAllBars over drift-free oscillating series produces all 3 regimes", () => {
    // Pure sinusoidal range without drift — ATR oscillates symmetrically
    // and the rolling-200 percentile cycles through low/middle/high.
    // Long-period sin (period > 200 bars) so the 200-bar rolling window
    // captures DIFFERENT phases at different sample bars; ratchet through
    // all 3 terciles. With drift the percentile would monotonically track
    // current vol UP and never re-visit the low tercile.
    const bars: PriceBar[] = [];
    for (let i = 0; i < 800; i++) {
      const range = 5 + 4 * Math.sin(i * 0.015); // oscillates 1..9 over ~420-bar period
      bars.push({
        date: new Date(1577836800000 + i * 4 * 3_600_000).toISOString(),
        open: 100, high: 100 + range, low: 100 - range, close: 100, volume: 0,
      });
    }
    const out = classifyAllBars(bars);
    const seen = new Set<string>();
    for (const r of out) if (r != null) seen.add(r);
    // The 3-regime classifier should hit all 3 buckets across a series
    // that spans multiple percentile rotations. If only 2 fire, the
    // tercile boundaries (33.33 / 66.67) aren't doing what the spec
    // promised.
    expect(seen.size).toBe(3);
  });
});

describe("classifyAllBars", () => {
  it("nulls bars before REGIME_LOOKBACK_BARS, classifies the rest", () => {
    const bars = syntheticBars(250, (i) => 1 + Math.sin(i * 0.1));
    const out = classifyAllBars(bars);
    expect(out).toHaveLength(250);
    for (let i = 0; i < REGIME_LOOKBACK_BARS; i++) {
      expect(out[i]).toBeNull();
    }
    let classifiedCount = 0;
    for (let i = REGIME_LOOKBACK_BARS; i < 250; i++) {
      if (out[i] != null) {
        classifiedCount++;
        expect(["low_vol", "medium_vol", "high_vol"] as Regime[]).toContain(out[i]);
      }
    }
    expect(classifiedCount).toBeGreaterThan(0);
  });

  it("handles small bar arrays gracefully (returns all null when n < lookback)", () => {
    const bars = syntheticBars(50, () => 1);
    const out = classifyAllBars(bars);
    expect(out.every((v) => v === null)).toBe(true);
  });
});
