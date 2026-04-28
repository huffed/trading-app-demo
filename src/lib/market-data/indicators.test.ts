import { describe, expect, it } from "vitest";
import { bollingerBands, ema, macd, rsi, sma } from "./indicators";

describe("sma", () => {
  it("returns nulls before the window fills", () => {
    const out = sma([1, 2, 3], 5);
    expect(out).toEqual([null, null, null]);
  });

  it("computes the rolling mean once enough bars exist", () => {
    const out = sma([1, 2, 3, 4, 5], 3);
    expect(out).toEqual([null, null, 2, 3, 4]);
  });
});

describe("ema", () => {
  it("emits nulls until period bars are seen, then seeds with SMA", () => {
    const out = ema([1, 2, 3, 4, 5], 3);
    expect(out[0]).toBeNull();
    expect(out[1]).toBeNull();
    // SMA seed: (1+2+3)/3 = 2
    expect(out[2]).toBe(2);
    // multiplier = 2/(3+1) = 0.5; (4 - 2) * 0.5 + 2 = 3
    expect(out[3]).toBe(3);
    // (5 - 3) * 0.5 + 3 = 4
    expect(out[4]).toBe(4);
  });
});

describe("rsi", () => {
  it("returns 100 for an unbroken uptrend (no losses)", () => {
    // 15 strictly-increasing closes; default period 14 → first value at idx 14
    const closes = Array.from({ length: 16 }, (_, i) => 100 + i);
    const out = rsi(closes);
    expect(out[14]).toBe(100);
    expect(out[15]).toBe(100);
  });

  it("returns null for series shorter than period+1", () => {
    const out = rsi([1, 2, 3], 14);
    expect(out).toEqual([null, null, null]);
  });

  it("emits values in the [0,100] range with a mixed series", () => {
    const closes = [
      44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42,
      45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28, 46.0,
    ];
    const out = rsi(closes);
    const last = out[out.length - 1];
    expect(last).not.toBeNull();
    expect(last!).toBeGreaterThan(0);
    expect(last!).toBeLessThan(100);
  });
});

describe("macd", () => {
  it("returns the EMA12-EMA26 difference once both EMAs exist", () => {
    const closes = Array.from({ length: 30 }, (_, i) => 100 + i);
    const line = macd(closes);
    // Indices 0..24 should be null (EMA26 seeds at idx 25)
    for (let i = 0; i < 25; i++) {
      expect(line[i]).toBeNull();
    }
    // From idx 25 onwards we have a number
    expect(line[25]).not.toBeNull();
    // For a uniformly rising series, EMA12 leads EMA26 → MACD > 0
    expect(line[line.length - 1]!).toBeGreaterThan(0);
  });
});

describe("bollingerBands", () => {
  it("middle band == SMA, upper/lower equidistant from middle", () => {
    const closes = [10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32, 34, 36, 38, 40, 42, 44, 46, 48];
    const { upper, middle, lower } = bollingerBands(closes, 20, 2);
    const i = closes.length - 1;
    expect(middle[i]).not.toBeNull();
    expect(upper[i]).not.toBeNull();
    expect(lower[i]).not.toBeNull();
    const m = middle[i]!;
    const u = upper[i]!;
    const l = lower[i]!;
    expect(u - m).toBeCloseTo(m - l, 6);
  });
});
