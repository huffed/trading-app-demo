import { describe, expect, it } from "vitest";
import { checkBarStaleness } from "./bar-staleness-gate";

// Age is measured from CLOSE = bars[last].date + tfMinutes. Each test
// passes an explicit `now` so the result is deterministic.
const open = (iso: string) => iso;
const at = (iso: string) => new Date(iso);

describe("checkBarStaleness — fresh-bar passes", () => {
  it("4h: bar at 09:00 open (close 13:00) is fresh at 16:30 — gate must not fire", () => {
    // Reproduces the 2026-05-12 false-positive: at 16:30 UTC the most-
    // recent closed 4h bar IS the 09:00 open / 13:00 close candle. The
    // next bar (13:00-17:00) is still forming. Gate should pass.
    const r = checkBarStaleness({
      timeframe: "4h",
      lastBarDate: open("2026-05-12 09:00:00"),
      now: at("2026-05-12T16:30:00Z"),
    });
    expect(r.block).toBe(false);
    expect(r.status).toBe("ok");
    expect(r.bar_age_minutes).toBeCloseTo(210, 0); // 16:30 - 13:00 = 3.5h
  });

  it("15m: just-closed bar reads as ~0 min past close", () => {
    const r = checkBarStaleness({
      timeframe: "15m",
      lastBarDate: open("2026-05-12 16:15:00"),
      now: at("2026-05-12T16:30:01Z"),
    });
    expect(r.block).toBe(false);
    expect(r.bar_age_minutes).toBeCloseTo(0, 0);
  });

  it("30m: bar within 0.5×TF grace after close passes", () => {
    // Bar opens 16:00, closes 16:30. At 16:45 (15 min after close) it's
    // still fresh — threshold is 45 min from close.
    const r = checkBarStaleness({
      timeframe: "30m",
      lastBarDate: open("2026-05-12 16:00:00"),
      now: at("2026-05-12T16:45:00Z"),
    });
    expect(r.block).toBe(false);
    expect(r.bar_age_minutes).toBeCloseTo(15, 0);
  });
});

describe("checkBarStaleness — genuine staleness blocks", () => {
  it("15m: bar 75 min past close fires (one missed bar + extra)", () => {
    // The actual 2026-05-12 incident shape: 15m bar at 00:30 open
    // (closed 00:45). At 01:30 it's 45 min past close → > 22.5 threshold.
    const r = checkBarStaleness({
      timeframe: "15m",
      lastBarDate: open("2026-05-12 00:30:00"),
      now: at("2026-05-12T01:30:00Z"),
    });
    expect(r.block).toBe(true);
    expect(r.status).toBe("stale");
    expect(r.bar_age_minutes).toBeCloseTo(45, 0);
  });

  it("4h: bar with one full bar missed fires", () => {
    // 4h bar at 01:00 open (close 05:00). At 12:00 we should be on
    // 05:00-open or 09:00-open; missing both means 7h past close.
    const r = checkBarStaleness({
      timeframe: "4h",
      lastBarDate: open("2026-05-12 01:00:00"),
      now: at("2026-05-12T12:00:00Z"),
    });
    expect(r.block).toBe(true);
    expect(r.bar_age_minutes).toBeCloseTo(420, 0); // 7h past 05:00 close
    expect(r.threshold_minutes).toBe(360);
  });
});

describe("checkBarStaleness — edge cases", () => {
  it("returns no_bars + non-blocking when lastBarDate is null", () => {
    const r = checkBarStaleness({
      timeframe: "15m",
      lastBarDate: null,
      now: at("2026-05-12T12:00:00Z"),
    });
    expect(r.block).toBe(false);
    expect(r.status).toBe("no_bars");
  });

  it("handles negative ages when scan lands before the bar's notional close", () => {
    // Edge: just-opened 4h bar at 13:00 evaluated at 13:05 — close at
    // 17:00 is in the future, so age is negative. Must not block.
    const r = checkBarStaleness({
      timeframe: "4h",
      lastBarDate: open("2026-05-12 13:00:00"),
      now: at("2026-05-12T13:05:00Z"),
    });
    expect(r.block).toBe(false);
    expect(r.bar_age_minutes).toBeLessThan(0);
  });
});
