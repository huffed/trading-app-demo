import { describe, expect, it } from "vitest";
import { checkSessionFilter } from "./session-filter";

function utc(hour: number): Date {
  return new Date(Date.UTC(2026, 3, 29, hour, 30, 0));
}

describe("checkSessionFilter", () => {
  it("passes through when filter is undefined", () => {
    expect(checkSessionFilter(undefined, utc(3)).outside).toBe(false);
  });

  it("passes through when filter is disabled regardless of hour", () => {
    const filter = { enabled: false, start_hour_utc: 7, end_hour_utc: 17 };
    expect(checkSessionFilter(filter, utc(2)).outside).toBe(false);
    expect(checkSessionFilter(filter, utc(22)).outside).toBe(false);
  });

  it("blocks entries before the start hour", () => {
    const filter = { enabled: true, start_hour_utc: 7, end_hour_utc: 17 };
    const r = checkSessionFilter(filter, utc(6));
    expect(r.outside).toBe(true);
    expect(r.reason).toContain("07-17");
  });

  it("allows entries inside the window", () => {
    const filter = { enabled: true, start_hour_utc: 7, end_hour_utc: 17 };
    expect(checkSessionFilter(filter, utc(7)).outside).toBe(false);
    expect(checkSessionFilter(filter, utc(12)).outside).toBe(false);
    expect(checkSessionFilter(filter, utc(16)).outside).toBe(false);
  });

  it("blocks entries at and after end_hour (exclusive boundary)", () => {
    const filter = { enabled: true, start_hour_utc: 7, end_hour_utc: 17 };
    expect(checkSessionFilter(filter, utc(17)).outside).toBe(true);
    expect(checkSessionFilter(filter, utc(22)).outside).toBe(true);
  });

  it("would have caught yesterday's 21:22 UTC AUD/USD entry", () => {
    const filter = { enabled: true, start_hour_utc: 7, end_hour_utc: 17 };
    expect(checkSessionFilter(filter, utc(21)).outside).toBe(true);
  });

  it("treats malformed (start >= end) filter as inside (defensive)", () => {
    const filter = { enabled: true, start_hour_utc: 17, end_hour_utc: 7 };
    expect(checkSessionFilter(filter, utc(12)).outside).toBe(false);
  });
});
