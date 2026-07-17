import { describe, expect, it } from "vitest";
import { alignBarIndex, alignCompletedDailyIndex, resampleToDaily } from "./resample";
import type { PriceBar } from "./types";

const bar = (date: string, close: number): PriceBar => ({
  date,
  open: close,
  high: close,
  low: close,
  close,
  volume: 0,
});

describe("alignCompletedDailyIndex", () => {
  const daily = [bar("2020-03-08", 1), bar("2020-03-09", 2), bar("2020-03-10", 3)];

  it("excludes the same-day bar for an intraday asOf (E2.24.a look-ahead)", () => {
    // alignBarIndex includes 2020-03-10 (midnight <= 08:00) — that bar's
    // close is the day's EOD close, i.e. future data at 08:00.
    expect(alignBarIndex(daily, "2020-03-10 08:00:00")).toBe(2);
    expect(alignCompletedDailyIndex(daily, "2020-03-10 08:00:00")).toBe(1);
  });

  it("includes the previous day once asOf rolls past midnight", () => {
    expect(alignCompletedDailyIndex(daily, "2020-03-11 00:00:00")).toBe(2);
  });

  it("handles ISO T-separated dates", () => {
    expect(alignCompletedDailyIndex(daily, "2020-03-09T12:00:00Z")).toBe(0);
  });

  it("returns -1 when no completed day exists", () => {
    expect(alignCompletedDailyIndex(daily, "2020-03-08 04:00:00")).toBe(-1);
    expect(alignCompletedDailyIndex([], "2020-03-10 08:00:00")).toBe(-1);
  });
});

describe("resampleToDaily + alignCompletedDailyIndex compose causally", () => {
  it("an intraday bar never sees a daily close from its own day", () => {
    const intraday = [
      bar("2020-03-09 00:00:00", 10),
      bar("2020-03-09 20:00:00", 15),
      bar("2020-03-10 00:00:00", 20),
      bar("2020-03-10 08:00:00", 25),
      bar("2020-03-10 20:00:00", 99), // EOD close — must be invisible at 08:00
    ];
    const daily = resampleToDaily(intraday);
    const dIdx = alignCompletedDailyIndex(daily, "2020-03-10 08:00:00");
    expect(daily[dIdx].date).toBe("2020-03-09");
    expect(daily[dIdx].close).toBe(15);
  });
});
