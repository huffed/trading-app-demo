import { describe, expect, it } from "vitest";
import {
  atr14,
  computeMarketState4h,
  lastIdxAtOrBefore,
  pctile,
  swingRegime,
} from "./market-state";
import type { PriceBar } from "./types";

function bar(date: string, o: number, h: number, l: number, c: number): PriceBar {
  return { date, open: o, high: h, low: l, close: c, volume: 0 };
}

/** n bars whose highs/lows step by `step` per bar (positive = uptrend).
 *  Dates are STRICTLY ASCENDING (month rolls every 28 bars) — the state
 *  module's lookups binary-search on date order. */
function trendBars(n: number, start: number, step: number): PriceBar[] {
  return Array.from({ length: n }, (_, i) => {
    const base = start + i * step;
    const month = String(Math.floor(i / 28) + 1).padStart(2, "0");
    const day = String((i % 28) + 1).padStart(2, "0");
    return bar(`2026-${month}-${day} 00:00:00`, base, base + 2, base - 2, base + 1);
  });
}

describe("swingRegime", () => {
  it("reads rising 3v4 highs+lows as HH", () => {
    const bars = trendBars(20, 100, 5);
    expect(swingRegime(bars, 19)).toBe("HH");
  });
  it("reads falling 3v4 highs+lows as LH", () => {
    const bars = trendBars(20, 200, -5);
    expect(swingRegime(bars, 19)).toBe("LH");
  });
  it("reads flat structure as RANGING", () => {
    const bars = trendBars(20, 100, 0);
    expect(swingRegime(bars, 19)).toBe("RANGING");
  });
  it("returns null with insufficient history", () => {
    expect(swingRegime(trendBars(5, 100, 1), 4)).toBeNull();
  });
});

describe("pctile", () => {
  it("returns null on thin history (honesty guard)", () => {
    expect(pctile([1, 2, 3], 2)).toBeNull();
  });
  it("computes fraction strictly below", () => {
    const hist = Array.from({ length: 100 }, (_, i) => i); // 0..99
    expect(pctile(hist, 50)).toBeCloseTo(0.5);
    expect(pctile(hist, 0)).toBe(0);
    expect(pctile(hist, 1000)).toBe(1);
  });
});

describe("atr14", () => {
  it("needs 15 bars of history", () => {
    expect(atr14(trendBars(10, 100, 1), 9)).toBeNull();
  });
  it("equals bar range for constant-range bars", () => {
    // every bar: high-low = 4, no gaps beyond that → ATR = 4
    expect(atr14(trendBars(30, 100, 0), 29)).toBeCloseTo(4);
  });
});

describe("lastIdxAtOrBefore", () => {
  const bars = [
    bar("2026-01-01 00:00:00", 1, 2, 0, 1),
    bar("2026-01-02 00:00:00", 1, 2, 0, 1),
    bar("2026-01-04 00:00:00", 1, 2, 0, 1),
  ];
  it("finds exact and between matches", () => {
    expect(lastIdxAtOrBefore(bars, "2026-01-02 00:00:00")).toBe(1);
    expect(lastIdxAtOrBefore(bars, "2026-01-03 12:00:00")).toBe(1);
    expect(lastIdxAtOrBefore(bars, "2025-12-31 00:00:00")).toBe(-1);
  });
});

describe("computeMarketState4h", () => {
  it("degrades every feature to n/a on empty inputs, never throws", () => {
    const s = computeMarketState4h(
      { bars4h: trendBars(10, 100, 1), oneHourBars: [], dailyBars: [], eurusd4h: [] },
      9
    );
    expect(s).toEqual({ mtf: "n/a", vol: "n/a", range: "n/a", dxy: "n/a" });
  });
  it("returns all-n/a for an out-of-range index", () => {
    const s = computeMarketState4h(
      { bars4h: [], oneHourBars: [], dailyBars: [], eurusd4h: [] },
      0
    );
    expect(s).toEqual({ mtf: "n/a", vol: "n/a", range: "n/a", dxy: "n/a" });
  });
  it("flags fast_div_bull when 1h is HH while D1 is not", () => {
    const bars4h = trendBars(200, 100, 0); // 4h RANGING
    const oneHour = trendBars(50, 100, 5); // 1h HH
    const daily = trendBars(50, 200, -5); // D1 LH — but date matching matters:
    // give daily bars dates well before the 4h bar's date so the
    // strictly-before lookup lands on the last daily bar.
    const dailyDated = daily.map((b, i) => ({
      ...b,
      date: `2025-11-${String((i % 28) + 1).padStart(2, "0")}`,
    }));
    // ensure the daily series is date-ascending for binary search
    dailyDated.sort((a, b) => (a.date < b.date ? -1 : 1));
    const s = computeMarketState4h(
      { bars4h, oneHourBars: oneHour, dailyBars: dailyDated, eurusd4h: [] },
      199
    );
    expect(s.mtf).toBe("fast_div_bull");
  });
  it("reads USD trend from EUR/USD slope (EUR up = usd_down)", () => {
    const bars4h = trendBars(60, 100, 0);
    const eur = trendBars(60, 1.0, 0.001); // steadily rising EUR
    const s = computeMarketState4h(
      { bars4h, oneHourBars: [], dailyBars: [], eurusd4h: eur },
      59
    );
    expect(s.dxy).toBe("usd_down");
  });
});
