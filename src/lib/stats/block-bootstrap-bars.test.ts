import { describe, expect, it } from "vitest";
import type { PriceBar } from "@/lib/market-data/types";
import {
  blockBootstrapBars,
  blockBootstrapBarsMany,
  medianBarSpacingMs,
} from "./block-bootstrap-bars";

const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;

function buildBars(n: number, startMs = Date.UTC(2024, 0, 1, 0, 0, 0)): PriceBar[] {
  const out: PriceBar[] = [];
  for (let i = 0; i < n; i++) {
    const ts = new Date(startMs + i * FOUR_HOURS_MS).toISOString();
    // Distinctive prices per bar so we can verify which source bar was picked.
    out.push({
      date: ts,
      open: 1000 + i,
      high: 1010 + i,
      low: 990 + i,
      close: 1005 + i,
      volume: i + 1,
    });
  }
  return out;
}

describe("medianBarSpacingMs", () => {
  it("returns 0 for empty series", () => {
    expect(medianBarSpacingMs([])).toBe(0);
  });

  it("returns 0 for single-bar series", () => {
    expect(medianBarSpacingMs(buildBars(1))).toBe(0);
  });

  it("returns spacing for evenly-spaced 4h series", () => {
    const bars = buildBars(100);
    expect(medianBarSpacingMs(bars)).toBe(FOUR_HOURS_MS);
  });

  it("robust against a single irregular spacing (weekend gap simulation)", () => {
    const bars = buildBars(50);
    // Insert a 2-day gap before bar 25.
    const gapMs = 2 * 24 * 60 * 60 * 1000;
    const mutated = bars.map((b, i) => {
      if (i < 25) return b;
      return {
        ...b,
        timestamp: new Date(new Date(b.date).getTime() + gapMs).toISOString(),
      };
    });
    // Most spacings are still 4h; median should pick the 4h modal value.
    expect(medianBarSpacingMs(mutated)).toBe(FOUR_HOURS_MS);
  });
});

describe("blockBootstrapBars", () => {
  it("returns empty for empty input", () => {
    expect(blockBootstrapBars([], { blockSize: 5, seed: 42 })).toEqual([]);
  });

  it("throws on blockSize < 1", () => {
    expect(() => blockBootstrapBars(buildBars(50), { blockSize: 0, seed: 42 })).toThrow(
      /blockSize must be ≥ 1/,
    );
  });

  it("throws on blockSize > bars.length", () => {
    expect(() => blockBootstrapBars(buildBars(10), { blockSize: 20, seed: 42 })).toThrow(
      /blockSize \(20\) cannot exceed bars\.length \(10\)/,
    );
  });

  it("throws on outputLength < 1", () => {
    expect(() =>
      blockBootstrapBars(buildBars(50), { blockSize: 5, seed: 42, outputLength: 0 }),
    ).toThrow(/outputLength must be ≥ 1/);
  });

  it("output length matches outputLength (default = input length)", () => {
    const bars = buildBars(200);
    const result = blockBootstrapBars(bars, { blockSize: 24, seed: 42 });
    expect(result.length).toBe(200);
  });

  it("output length matches explicit outputLength", () => {
    const bars = buildBars(200);
    const result = blockBootstrapBars(bars, { blockSize: 24, seed: 42, outputLength: 100 });
    expect(result.length).toBe(100);
  });

  it("synthetic timestamps are strictly monotonic", () => {
    const bars = buildBars(500);
    const result = blockBootstrapBars(bars, { blockSize: 24, seed: 42 });
    for (let i = 1; i < result.length; i++) {
      const prev = new Date(result[i - 1].date).getTime();
      const curr = new Date(result[i].date).getTime();
      expect(curr).toBeGreaterThan(prev);
    }
  });

  it("synthetic timestamps end on original's last timestamp (OOS_CUTOFF preserving)", () => {
    const bars = buildBars(500);
    const result = blockBootstrapBars(bars, { blockSize: 24, seed: 42 });
    expect(result[result.length - 1].date).toBe(bars[bars.length - 1].date);
  });

  it("same seed → identical output (determinism)", () => {
    const bars = buildBars(300);
    const a = blockBootstrapBars(bars, { blockSize: 24, seed: 100 });
    const b = blockBootstrapBars(bars, { blockSize: 24, seed: 100 });
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i++) {
      expect(a[i]).toEqual(b[i]);
    }
  });

  it("different seeds → different output (variability)", () => {
    const bars = buildBars(300);
    const a = blockBootstrapBars(bars, { blockSize: 24, seed: 1 });
    const b = blockBootstrapBars(bars, { blockSize: 24, seed: 2 });
    // Prices should differ in MOST positions (allows occasional coincidental matches).
    let differingPositions = 0;
    for (let i = 0; i < a.length; i++) {
      if (a[i].close !== b[i].close) differingPositions++;
    }
    expect(differingPositions).toBeGreaterThan(a.length * 0.5);
  });

  it("preserves OHLC integrity within each block (block-level structure)", () => {
    const bars = buildBars(500);
    const result = blockBootstrapBars(bars, { blockSize: 24, seed: 42 });
    // Pull any (open, high, low, close) tuple from the result; it must
    // EXACTLY equal some source bar's (o, h, l, c) tuple — block-bootstrap
    // never invents new prices, only re-orders existing ones.
    const sourceTuples = new Set(
      bars.map((b) => `${b.open}|${b.high}|${b.low}|${b.close}|${b.volume}`),
    );
    for (const r of result) {
      const tuple = `${r.open}|${r.high}|${r.low}|${r.close}|${r.volume}`;
      expect(sourceTuples.has(tuple)).toBe(true);
    }
  });

  it("blockSize=bars.length produces a single block (degenerate but valid)", () => {
    const bars = buildBars(50);
    const result = blockBootstrapBars(bars, { blockSize: 50, seed: 42 });
    // Only one possible start (0), so result is identical to input by price (timestamps re-indexed).
    for (let i = 0; i < bars.length; i++) {
      expect(result[i].open).toBe(bars[i].open);
      expect(result[i].close).toBe(bars[i].close);
    }
  });

  it("blockSize=1 approximates i.i.d. bootstrap (no block structure)", () => {
    const bars = buildBars(300);
    const result = blockBootstrapBars(bars, { blockSize: 1, seed: 42 });
    expect(result.length).toBe(300);
    // Strictly-monotonic timestamps still hold.
    for (let i = 1; i < result.length; i++) {
      const prev = new Date(result[i - 1].date).getTime();
      const curr = new Date(result[i].date).getTime();
      expect(curr).toBeGreaterThan(prev);
    }
  });
});

describe("blockBootstrapBarsMany", () => {
  it("throws on nResamples < 1", () => {
    expect(() =>
      blockBootstrapBarsMany(buildBars(50), 0, { blockSize: 5, baseSeed: 42 }),
    ).toThrow(/nResamples must be ≥ 1/);
  });

  it("produces N independent resamples", () => {
    const bars = buildBars(200);
    const resamples = blockBootstrapBarsMany(bars, 5, { blockSize: 24, baseSeed: 100 });
    expect(resamples.length).toBe(5);
    for (const r of resamples) {
      expect(r.length).toBe(200);
    }
  });

  it("baseSeed + i derivation: resample[0] equals direct call with baseSeed", () => {
    const bars = buildBars(200);
    const many = blockBootstrapBarsMany(bars, 3, { blockSize: 24, baseSeed: 100 });
    const direct = blockBootstrapBars(bars, { blockSize: 24, seed: 100 });
    for (let i = 0; i < direct.length; i++) {
      expect(many[0][i]).toEqual(direct[i]);
    }
  });

  it("each resample uses a distinct seed (output diversity)", () => {
    const bars = buildBars(200);
    const resamples = blockBootstrapBarsMany(bars, 4, { blockSize: 24, baseSeed: 100 });
    // Compare close-price sequences pairwise; expect every pair to differ in MOST positions.
    for (let i = 0; i < resamples.length; i++) {
      for (let j = i + 1; j < resamples.length; j++) {
        let differ = 0;
        for (let k = 0; k < resamples[i].length; k++) {
          if (resamples[i][k].close !== resamples[j][k].close) differ++;
        }
        expect(differ).toBeGreaterThan(resamples[i].length * 0.5);
      }
    }
  });
});
