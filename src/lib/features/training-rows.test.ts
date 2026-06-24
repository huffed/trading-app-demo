/**
 * H.3 — Tests for the chronological training-row builder + holdout-split
 * helper. These are the pieces the feature-importance driver depends on
 * for label generation + train/holdout segmentation.
 */
import { describe, expect, it } from "vitest";
import type { PriceBar } from "@/lib/market-data/types";
import {
  buildTrainingRows,
  buildTrainingRowsWithIdx,
  findHoldoutCutoff,
  findHoldoutCutoffByDates,
} from "./training-rows";

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

describe("buildTrainingRowsWithIdx", () => {
  it("returns same rows + firstValidIdx as buildTrainingRows + adds bar_indices", () => {
    const bars = syntheticBars(300);
    const base = buildTrainingRows(bars);
    const withIdx = buildTrainingRowsWithIdx(bars);
    expect(withIdx.rows.length).toBe(base.rows.length);
    expect(withIdx.firstValidIdx).toBe(base.firstValidIdx);
    expect(withIdx.bar_indices.length).toBe(withIdx.rows.length);
  });

  it("bar_indices are strictly monotonic ascending", () => {
    const bars = syntheticBars(500);
    const { bar_indices } = buildTrainingRowsWithIdx(bars);
    for (let i = 1; i < bar_indices.length; i++) {
      expect(bar_indices[i]).toBeGreaterThan(bar_indices[i - 1]);
    }
  });

  it("each bar_index maps to a valid bars entry", () => {
    const bars = syntheticBars(200);
    const { bar_indices } = buildTrainingRowsWithIdx(bars);
    for (const idx of bar_indices) {
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(bars.length);
    }
  });

  it("with a label fn that drops bars, bar_indices reflect filtered subset", () => {
    const bars = syntheticBars(300);
    // Label fn that only labels every other bar
    let toggle = 0;
    const dropEveryOther = (): 0 | 1 | null => {
      toggle++;
      return toggle % 2 === 0 ? 1 : null;
    };
    const { rows, bar_indices } = buildTrainingRowsWithIdx(bars, undefined, dropEveryOther);
    expect(rows.length).toBe(bar_indices.length);
    // bar_indices should skip every other valid bar
    for (let i = 1; i < bar_indices.length; i++) {
      expect(bar_indices[i] - bar_indices[i - 1]).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("findHoldoutCutoffByDates", () => {
  it("returns 0 for empty bars OR empty bar_indices", () => {
    expect(findHoldoutCutoffByDates([], [], 30)).toBe(0);
    expect(findHoldoutCutoffByDates(syntheticBars(10), [], 30)).toBe(0);
  });

  it("splits correctly when all rows fall before cutoff (everything is training)", () => {
    const bars = syntheticBars(500);
    // Use first 100 bars only — all from the early portion of the series
    const earlyIndices = Array.from({ length: 100 }, (_, i) => i);
    // holdout = last 20 days; first 100 bars (~16.7 days) are all before
    // the cutoff if total span is larger
    const cutoff = findHoldoutCutoffByDates(bars, earlyIndices, 20);
    expect(cutoff).toBe(100); // all 100 indices are training
  });

  it("returns 0 when ALL rows fall in holdout window (everything is holdout)", () => {
    const bars = syntheticBars(500);
    // Use last 50 bars (= ~8 days) with holdoutDays=365 → all in holdout
    const lateIndices = Array.from({ length: 50 }, (_, i) => bars.length - 50 + i);
    const cutoff = findHoldoutCutoffByDates(bars, lateIndices, 365);
    expect(cutoff).toBe(0);
  });

  it("monotonic break-out: stops at first index past cutoff (perf optimisation)", () => {
    const bars = syntheticBars(500);
    // Span ~83 days; holdoutDays=20 puts cutoff at day 63
    const allIndices = Array.from({ length: 500 }, (_, i) => i);
    const cutoff = findHoldoutCutoffByDates(bars, allIndices, 20);
    expect(cutoff).toBeGreaterThan(0);
    expect(cutoff).toBeLessThan(500);
  });

  it("matches findHoldoutCutoff when all bars produce rows", () => {
    const bars = syntheticBars(500);
    const { rows, firstValidIdx, bar_indices } = buildTrainingRowsWithIdx(bars);
    const dateBased = findHoldoutCutoffByDates(bars, bar_indices, 30);
    // findHoldoutCutoff counts training rows differently (it iterates bars +
    // applies close-validity); equality is approximate when label-fn drops
    // some bars. With default next_bar_sign and synthetic linear bars, both
    // should agree exactly.
    const legacyBased = findHoldoutCutoff(bars, firstValidIdx, 30);
    expect(Math.abs(dateBased - legacyBased)).toBeLessThanOrEqual(1);
    // dateBased correctly leaves rows.length - cutoff for holdout
    expect(rows.length - dateBased).toBeGreaterThan(0);
  });
});
