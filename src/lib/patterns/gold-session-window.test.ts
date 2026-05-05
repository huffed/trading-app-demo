import { describe, expect, it } from "vitest";
import type { PriceBar } from "@/lib/market-data/types";
import { detectSessionWindow, SESSION_WINDOWS } from "./gold-session-window";

function bar(date: string, close = 1.0): PriceBar {
  return { date, open: close, high: close + 0.001, low: close - 0.001, close, volume: 0 };
}

describe("detectSessionWindow", () => {
  it("fires inside ny_killzone window (UTC 11-15)", () => {
    const bars = [bar("2026-04-30T13:00:00Z")];
    const r = detectSessionWindow(bars, 0, { session: "ny_killzone" });
    expect(r.detected).toBe(true);
    expect(r.details?.hour_utc).toBe(13);
    expect(r.details?.session).toBe("ny_killzone");
  });

  it("does not fire on the upper bound (exclusive)", () => {
    const bars = [bar("2026-04-30T15:00:00Z")];
    expect(detectSessionWindow(bars, 0, { session: "ny_killzone" }).detected).toBe(false);
  });

  it("fires on the lower bound (inclusive)", () => {
    const bars = [bar("2026-04-30T11:00:00Z")];
    expect(detectSessionWindow(bars, 0, { session: "ny_killzone" }).detected).toBe(true);
  });

  it("does not fire outside the window", () => {
    const bars = [bar("2026-04-30T05:00:00Z")];
    expect(detectSessionWindow(bars, 0, { session: "ny_killzone" }).detected).toBe(false);
  });

  it("matches asian_session window (UTC 0-7)", () => {
    const inside = [bar("2026-04-30T03:00:00Z")];
    const outside = [bar("2026-04-30T08:00:00Z")];
    expect(detectSessionWindow(inside, 0, { session: "asian_session" }).detected).toBe(true);
    expect(detectSessionWindow(outside, 0, { session: "asian_session" }).detected).toBe(false);
  });

  it("matches london_open window (UTC 6-10)", () => {
    const inside = [bar("2026-04-30T07:30:00Z")];
    const outside = [bar("2026-04-30T11:00:00Z")];
    expect(detectSessionWindow(inside, 0, { session: "london_open" }).detected).toBe(true);
    expect(detectSessionWindow(outside, 0, { session: "london_open" }).detected).toBe(false);
  });

  it("matches silver_bullet narrow window (UTC 14-16)", () => {
    const inside = [bar("2026-04-30T14:30:00Z")];
    const outside = [bar("2026-04-30T13:00:00Z")];
    expect(detectSessionWindow(inside, 0, { session: "silver_bullet" }).detected).toBe(true);
    expect(detectSessionWindow(outside, 0, { session: "silver_bullet" }).detected).toBe(false);
  });

  it("returns false for malformed date", () => {
    const bars: PriceBar[] = [{ date: "not-a-date", open: 1, high: 1, low: 1, close: 1, volume: 0 }];
    expect(detectSessionWindow(bars, 0, { session: "ny_killzone" }).detected).toBe(false);
  });

  it("returns false for missing bar", () => {
    expect(detectSessionWindow([], 0, { session: "ny_killzone" }).detected).toBe(false);
  });

  it("exposes the window ranges via SESSION_WINDOWS", () => {
    expect(SESSION_WINDOWS.ny_killzone).toEqual({ start_utc: 11, end_utc: 15 });
    expect(SESSION_WINDOWS.asian_session).toEqual({ start_utc: 0, end_utc: 7 });
  });
});
