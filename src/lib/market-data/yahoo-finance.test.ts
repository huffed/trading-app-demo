/**
 * Unit tests for the Yahoo Finance fetcher guards (E2.19.c + E2.25.a.ii).
 *
 * Two failure modes locked:
 *  1. Yahoo includes the currently-forming candle with no completeness
 *     flag → dropFormingTail must remove it (fetch-time partial bar; a
 *     single odd tail bar slips past the DQ.3 median-spacing guard).
 *  2. Yahoo has no 4h granularity — the old mapping served 1h bars AS
 *     the 4h series (the 2026-07-19/20 in-memory granularity incident).
 *     fetchDailyPrices must refuse 4h outright.
 */
import { describe, expect, it } from "vitest";
import { dropFormingTail, fetchDailyPrices } from "./yahoo-finance";
import type { PriceBar } from "./types";

function bar(dateIso: string): PriceBar {
  return { date: dateIso, open: 1, high: 2, low: 0.5, close: 1.5, volume: 100 };
}

describe("dropFormingTail (E2.19.c)", () => {
  const now = Date.parse("2026-07-29T14:30:00Z");

  it("drops an intraday tail bar whose close hasn't arrived", () => {
    const bars = [
      bar("2026-07-29T12:00:00.000Z"), // closed 13:00
      bar("2026-07-29T13:00:00.000Z"), // closed 14:00
      bar("2026-07-29T14:00:00.000Z"), // closes 15:00 — FORMING at 14:30
    ];
    const out = dropFormingTail(bars, "1h", now);
    expect(out).toHaveLength(2);
    expect(out[out.length - 1].date).toBe("2026-07-29T13:00:00.000Z");
  });

  it("keeps a tail bar that closed exactly at now", () => {
    const bars = [bar("2026-07-29T13:00:00.000Z"), bar("2026-07-29T13:30:00.000Z")];
    // 30min bar opened 13:30 closes exactly 14:00; now=14:00 → complete.
    const out = dropFormingTail(bars, "30min", Date.parse("2026-07-29T14:00:00Z"));
    expect(out).toHaveLength(2);
  });

  it("drops today's forming DAILY bar, keeps yesterday's", () => {
    const bars = [bar("2026-07-28"), bar("2026-07-29")];
    // Daily "2026-07-29" closes 2026-07-30T00:00Z under the open+1440min
    // approximation → forming at 14:30Z.
    const out = dropFormingTail(bars, "1day", now);
    expect(out).toHaveLength(1);
    expect(out[0].date).toBe("2026-07-28");
  });

  it("drops unparseable-date bars rather than treating them as complete", () => {
    const bars = [bar("2026-07-29T12:00:00.000Z"), bar("not-a-date")];
    const out = dropFormingTail(bars, "1h", now);
    expect(out).toHaveLength(1);
  });

  it("empty input → empty output", () => {
    expect(dropFormingTail([], "1h", now)).toEqual([]);
  });
});

describe("fetchDailyPrices 4h refusal (E2.25.a.ii root cause)", () => {
  it("throws immediately for 4h — never serves 1h bars as the 4h series", async () => {
    await expect(fetchDailyPrices("XAU/USD", "full", "4h")).rejects.toThrow(
      /no 4h granularity/
    );
  });
});
