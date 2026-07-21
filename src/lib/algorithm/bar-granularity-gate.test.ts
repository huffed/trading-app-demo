/**
 * Unit tests for the bar-granularity gate (E2.25.a.ii).
 *
 * The live incident this locks: 2026-07-19 → 07-20 a fallback provider
 * served a 1h-granularity payload as the XAU/USD 4h series for ~24h
 * (every ATR reading exactly halved — √4 range scaling). DQ.4 blocked
 * persistence but the scan evaluated the in-memory payload anyway.
 */
import { describe, expect, it } from "vitest";
import type { PriceBar } from "@/lib/market-data/types";
import {
  GRANULARITY_LOWER_BOUND,
  GRANULARITY_UPPER_BOUND,
  checkBarGranularity,
} from "./bar-granularity-gate";

/** Build a series with the given consecutive spacings (minutes). */
function barsWithSpacings(spacingsMinutes: number[]): PriceBar[] {
  const bars: PriceBar[] = [];
  let t = Date.UTC(2026, 6, 6, 0, 0, 0); // Mon 2026-07-06 00:00Z
  bars.push(makeBar(t));
  for (const s of spacingsMinutes) {
    t += s * 60_000;
    bars.push(makeBar(t));
  }
  return bars;
}

function makeBar(ms: number): PriceBar {
  return {
    date: new Date(ms).toISOString(),
    open: 3300,
    high: 3310,
    low: 3290,
    close: 3305,
    volume: 100,
  };
}

describe("checkBarGranularity", () => {
  it("clean 4h series (incl. a weekend gap) → ok", () => {
    // 29 × 240-min spacings + one 2,880-min weekend gap; median stays 240.
    const spacings = [...Array.from({ length: 29 }, () => 240), 2880];
    const result = checkBarGranularity({ timeframe: "4h", bars: barsWithSpacings(spacings) });
    expect(result.block).toBe(false);
    expect(result.status).toBe("ok");
    expect(result.median_spacing_minutes).toBe(240);
    expect(result.expected_minutes).toBe(240);
  });

  it("1h payload served as the 4h series → blocked as finer (the live incident)", () => {
    const spacings = Array.from({ length: 40 }, () => 60);
    const result = checkBarGranularity({ timeframe: "4h", bars: barsWithSpacings(spacings) });
    expect(result.block).toBe(true);
    expect(result.status).toBe("granularity_mismatch");
    expect(result.median_spacing_minutes).toBe(60);
    expect(result.reason).toContain("finer");
    expect(result.reason).toContain("60.0 min");
    expect(result.reason).toContain("240 min");
  });

  it("daily payload served as the 4h series → blocked as coarser (timeframe fall-through class)", () => {
    const spacings = Array.from({ length: 20 }, () => 1440);
    const result = checkBarGranularity({ timeframe: "4h", bars: barsWithSpacings(spacings) });
    expect(result.block).toBe(true);
    expect(result.status).toBe("granularity_mismatch");
    expect(result.reason).toContain("coarser");
  });

  it("clean daily series with weekend gaps → ok (median ignores the gaps)", () => {
    // Mon→Fri 1440-min spacings + Fri→Mon 4320 gaps across 4 weeks.
    const week = [1440, 1440, 1440, 1440, 4320];
    const spacings = [...week, ...week, ...week, ...week];
    const result = checkBarGranularity({ timeframe: "1d", bars: barsWithSpacings(spacings) });
    expect(result.block).toBe(false);
    expect(result.median_spacing_minutes).toBe(1440);
    expect(result.expected_minutes).toBe(1440);
  });

  it("clean 15m series → ok; 1m payload served as 15m → blocked", () => {
    const clean = checkBarGranularity({
      timeframe: "15m",
      bars: barsWithSpacings(Array.from({ length: 40 }, () => 15)),
    });
    expect(clean.block).toBe(false);

    const polluted = checkBarGranularity({
      timeframe: "15m",
      bars: barsWithSpacings(Array.from({ length: 40 }, () => 1)),
    });
    expect(polluted.block).toBe(true);
    expect(polluted.status).toBe("granularity_mismatch");
  });

  it("too-short series (< 3 bars) → insufficient_bars, passes through", () => {
    const result = checkBarGranularity({ timeframe: "4h", bars: barsWithSpacings([240]) });
    expect(result.block).toBe(false);
    expect(result.status).toBe("insufficient_bars");
    expect(result.median_spacing_minutes).toBeNull();
  });

  it("empty series → insufficient_bars, passes through", () => {
    const result = checkBarGranularity({ timeframe: "4h", bars: [] });
    expect(result.block).toBe(false);
    expect(result.status).toBe("insufficient_bars");
  });

  it("boundary: median exactly at the 0.75× lower bound passes (mirrors DQ.3 strict-less-than)", () => {
    const lower = 240 * GRANULARITY_LOWER_BOUND; // 180
    const result = checkBarGranularity({
      timeframe: "4h",
      bars: barsWithSpacings(Array.from({ length: 20 }, () => lower)),
    });
    expect(result.block).toBe(false);
  });

  it("boundary: median exactly at the 1.5× upper bound passes; just above blocks", () => {
    const upper = 240 * GRANULARITY_UPPER_BOUND; // 360
    const atBound = checkBarGranularity({
      timeframe: "4h",
      bars: barsWithSpacings(Array.from({ length: 20 }, () => upper)),
    });
    expect(atBound.block).toBe(false);

    const above = checkBarGranularity({
      timeframe: "4h",
      bars: barsWithSpacings(Array.from({ length: 20 }, () => upper + 30)),
    });
    expect(above.block).toBe(true);
  });

  it("unparseable dates → insufficient_bars, passes through (no throw)", () => {
    const bars: PriceBar[] = Array.from({ length: 10 }, () => ({
      date: "not-a-date",
      open: 1,
      high: 1,
      low: 1,
      close: 1,
      volume: 1,
    }));
    const result = checkBarGranularity({ timeframe: "4h", bars });
    expect(result.block).toBe(false);
    expect(result.status).toBe("insufficient_bars");
  });
});
