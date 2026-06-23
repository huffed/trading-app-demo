/**
 * H.3 — Tests for the chronological training-row builder + holdout-split
 * helper. These are the pieces the feature-importance driver depends on
 * for label generation + train/holdout segmentation.
 */
import { describe, expect, it } from "vitest";
import { buildTrainingRows, findHoldoutCutoff } from "./training-rows";
import type { PriceBar } from "@/lib/market-data/types";

const T0 = new Date("2026-01-01T00:00:00Z").getTime();

function bar(daysFromT0: number, open: number, close: number): PriceBar {
  return {
    date: new Date(T0 + daysFromT0 * 86_400_000).toISOString(),
    open,
    high: Math.max(open, close) + 1,
    low: Math.min(open, close) - 1,
    close,
    volume: 100,
  };
}

/** Realistic synthetic series — enough bars for feature lookback (200+)
 *  and to exercise both label classes. */
function syntheticBars(n: number): PriceBar[] {
  const bars: PriceBar[] = [];
  let close = 2000;
  for (let i = 0; i < n; i++) {
    const drift = 0.05;
    const noise = Math.sin(i * 0.7) * 8 + Math.cos(i * 0.31) * 5;
    const newClose = close + drift + noise;
    bars.push({
      date: new Date(T0 + i * 4 * 3_600_000).toISOString(),
      open: close,
      high: Math.max(close, newClose) + 2,
      low: Math.min(close, newClose) - 2,
      close: newClose,
      volume: 100,
    });
    close = newClose;
  }
  return bars;
}

describe("buildTrainingRows", () => {
  it("returns 0 rows for empty bars", () => {
    const { rows, firstValidIdx } = buildTrainingRows([]);
    expect(rows).toHaveLength(0);
    expect(firstValidIdx).toBe(-1);
  });

  it("returns 0 rows when only one bar (no next-bar return possible)", () => {
    const { rows } = buildTrainingRows([bar(0, 100, 101)]);
    expect(rows).toHaveLength(0);
  });

  it("skips the LAST bar (no label) — returns n-1 rows for clean fixture", () => {
    // Use enough bars so every bar has SOME computable feature
    const bars = syntheticBars(300);
    const { rows, firstValidIdx } = buildTrainingRows(bars);
    // firstValidIdx ≥ 0; rows.length should equal (bars.length - 1) - firstValidIdx
    // (since iteration goes 0..n-2 and only skips pre-feature bars)
    expect(firstValidIdx).toBeGreaterThanOrEqual(0);
    expect(rows.length).toBe(bars.length - 1 - firstValidIdx);
  });

  it("label is 1 when next close > current close, 0 otherwise", () => {
    // Build a 5-bar series with known up/down sequence + enough lookback
    // (use the synthetic generator + check the last few labels)
    const bars = syntheticBars(250);
    const { rows } = buildTrainingRows(bars);
    // Spot-check: for each row, verify label matches the manual rule
    const lastFewRows = rows.slice(-3);
    const lastFewBars = bars.slice(-4); // need n+1 bars to compute n labels
    for (let i = 0; i < lastFewRows.length; i++) {
      const cur = lastFewBars[i].close;
      const next = lastFewBars[i + 1].close;
      const expected = next > cur ? 1 : 0;
      expect(lastFewRows[i].label).toBe(expected);
    }
  });

  it("skips rows with broken close values (NaN, non-positive)", () => {
    // Mix valid + invalid bars
    const bars: PriceBar[] = [
      ...syntheticBars(50),
      bar(50, NaN, NaN), // broken
      bar(51, -1, -1), // broken (close ≤ 0)
      ...syntheticBars(50).map((b, i) => ({ ...b, date: new Date(T0 + (52 + i) * 4 * 3_600_000).toISOString() })),
    ];
    const { rows } = buildTrainingRows(bars);
    // The broken bars produce no row but don't crash
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.label === 0 || r.label === 1).toBe(true);
    }
  });

  it("each row has a label ∈ {0, 1} and features as a name→value record", () => {
    const bars = syntheticBars(250);
    const { rows } = buildTrainingRows(bars);
    for (const r of rows.slice(0, 5)) {
      expect([0, 1]).toContain(r.label);
      expect(typeof r.features).toBe("object");
      // At least one feature should be non-null for valid rows
      const nonNullCount = Object.values(r.features).filter((v) => v !== null).length;
      expect(nonNullCount).toBeGreaterThan(0);
    }
  });
});

describe("findHoldoutCutoff", () => {
  it("returns 0 for empty bars / negative firstValidIdx", () => {
    expect(findHoldoutCutoff([], 0, 30)).toBe(0);
    expect(findHoldoutCutoff(syntheticBars(10), -1, 30)).toBe(0);
  });

  it("returns 0 when holdout window exceeds data span (everything in holdout)", () => {
    // 100 bars × 4h = ~16.7 days. holdoutDays=365 → entire dataset is
    // INSIDE the holdout window (last 365 days covers all bars). The
    // helper returns 0 cutoff (everything is holdout). The driver's
    // min-split guard catches this degenerate case loudly rather than
    // training a 0-sample model.
    const bars = syntheticBars(100);
    const { firstValidIdx } = buildTrainingRows(bars);
    const cutoff = findHoldoutCutoff(bars, firstValidIdx, 365);
    expect(cutoff).toBe(0);
  });

  it("splits bars chronologically — last holdoutDays go to holdout", () => {
    // 500 bars × 4h = ~83 days. holdoutDays=20 → ~120 bars in holdout
    const bars = syntheticBars(500);
    const { rows, firstValidIdx } = buildTrainingRows(bars);
    const cutoff = findHoldoutCutoff(bars, firstValidIdx, 20);
    expect(cutoff).toBeGreaterThan(0);
    expect(cutoff).toBeLessThan(rows.length);
    // The cutoff bar's date should be near (lastBarDate - 20 days)
    const lastBarMs = new Date(bars[bars.length - 1].date).getTime();
    const expectedCutoffMs = lastBarMs - 20 * 86_400_000;
    // Find the bar at firstValidIdx + cutoff; its date should be at or after expectedCutoffMs
    const cutoffBarIdx = firstValidIdx + cutoff;
    if (cutoffBarIdx < bars.length) {
      const cutoffBarMs = new Date(bars[cutoffBarIdx].date).getTime();
      // Allow ±1 bar (4h) of slop for the bar-index discretisation
      expect(cutoffBarMs).toBeGreaterThanOrEqual(expectedCutoffMs - 4 * 3_600_000);
    }
  });

  it("determinism — repeat call with same inputs returns same cutoff", () => {
    const bars = syntheticBars(500);
    const { firstValidIdx } = buildTrainingRows(bars);
    const a = findHoldoutCutoff(bars, firstValidIdx, 30);
    const b = findHoldoutCutoff(bars, firstValidIdx, 30);
    expect(a).toBe(b);
  });
});
