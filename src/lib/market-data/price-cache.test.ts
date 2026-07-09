import { describe, expect, it } from "vitest";
import { medianSpacingMinutes, normalizeBarDate } from "./price-cache";
import type { PriceBar } from "./types";

/**
 * DQ.2 (2026-07-09): one instant must map to exactly one canonical string,
 * regardless of which provider format it arrived in. The pre-fix version
 * passed any `T…Z` string through untouched, so OANDA's nanosecond ISO and
 * Twelve Data's normalised ISO never collided in savePricesToCache's dedupe
 * Map — the XAU/USD 4h row accumulated 11,169 bars across 8,838 distinct
 * instants (62 duplicates inside the live 200-bar evaluation window).
 */
describe("normalizeBarDate", () => {
  const CANONICAL = "2026-07-09T13:00:00.000Z";

  it("collapses every provider format for the same instant to one string", () => {
    expect(normalizeBarDate("2026-07-09T13:00:00.000000000Z")).toBe(CANONICAL); // OANDA ns
    expect(normalizeBarDate("2026-07-09T13:00:00Z")).toBe(CANONICAL); // pre-fix normalised
    expect(normalizeBarDate("2026-07-09T13:00:00.000Z")).toBe(CANONICAL); // already canonical
    expect(normalizeBarDate("2026-07-09 13:00:00")).toBe(CANONICAL); // Twelve Data space
    expect(normalizeBarDate("2026-07-09T13:00:00")).toBe(CANONICAL); // ISO, no TZ marker
  });

  it("pads date-only bars to midnight UTC canonical", () => {
    expect(normalizeBarDate("2007-08-03")).toBe("2007-08-03T00:00:00.000Z");
  });

  it("collapses explicit-offset inputs to their UTC instant", () => {
    expect(normalizeBarDate("2026-07-09T15:00:00+02:00")).toBe(CANONICAL);
    expect(normalizeBarDate("2026-07-09T15:00:00.500000+0200")).toBe(
      "2026-07-09T13:00:00.500Z"
    );
  });

  it("is idempotent", () => {
    for (const input of [
      "2026-07-09T13:00:00.000000000Z",
      "2026-07-09 13:00:00",
      "2007-08-03",
    ]) {
      const once = normalizeBarDate(input);
      expect(normalizeBarDate(once)).toBe(once);
    }
  });

  it("returns unrecognised strings unchanged so downstream parsing surfaces them", () => {
    expect(normalizeBarDate("not-a-date")).toBe("not-a-date");
    expect(normalizeBarDate("07/09/2026")).toBe("07/09/2026");
  });
});

/**
 * DQ.3 (2026-07-09): the provider fallback chain served HOURLY bars under a
 * 4h cache request (observed 2026-07-07/08 in the XAU/USD 4h full row).
 * savePricesToCache rejects incoming sets whose median spacing is finer
 * than 0.75× the requested interval; medianSpacingMinutes is its measure.
 */
describe("medianSpacingMinutes", () => {
  const mkBars = (dates: string[]): PriceBar[] =>
    dates.map((date) => ({ date, open: 1, high: 1, low: 1, close: 1, volume: 0 }));

  it("medians 240 for a 4h grid even across a weekend gap", () => {
    expect(
      medianSpacingMinutes(
        mkBars([
          "2026-07-03T09:00:00.000Z",
          "2026-07-03T13:00:00.000Z",
          "2026-07-03T17:00:00.000Z",
          "2026-07-03T21:00:00.000Z",
          "2026-07-06T01:00:00.000Z", // weekend gap — median unaffected
          "2026-07-06T05:00:00.000Z",
          "2026-07-06T09:00:00.000Z",
        ])
      )
    ).toBe(240);
  });

  it("medians 60 for hourly pollution served under a 4h request", () => {
    expect(
      medianSpacingMinutes(
        mkBars([
          "2026-07-07T06:00:00.000Z",
          "2026-07-07T07:00:00.000Z",
          "2026-07-07T08:00:00.000Z",
          "2026-07-07T09:00:00.000Z",
        ])
      )
    ).toBe(60);
  });

  it("returns null when fewer than 3 bars", () => {
    expect(medianSpacingMinutes(mkBars(["2026-07-07T06:00:00.000Z"]))).toBeNull();
    expect(
      medianSpacingMinutes(
        mkBars(["2026-07-07T06:00:00.000Z", "2026-07-07T10:00:00.000Z"])
      )
    ).toBeNull();
  });
});
