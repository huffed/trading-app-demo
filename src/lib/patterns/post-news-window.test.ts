import { describe, expect, it } from "vitest";
import type { EconomicEvent } from "@/lib/market-data/economic-calendar";
import type { PriceBar } from "@/lib/market-data/types";
import { detectPostNewsWindow } from "./post-news-window";

function bar(date: string): PriceBar {
  return { date, open: 1, high: 1.001, low: 0.999, close: 1, volume: 0 };
}

const NFP: EconomicEvent = {
  time: "2026-05-01T12:30:00Z",
  currency: "USD",
  event: "Non-Farm Employment Change",
  impact: "high",
};

const LOW_IMPACT: EconomicEvent = {
  time: "2026-05-01T12:30:00Z",
  currency: "USD",
  event: "Routine release",
  impact: "low",
};

const EUR_EVENT: EconomicEvent = {
  time: "2026-05-01T12:30:00Z",
  currency: "EUR",
  event: "ECB Rate Decision",
  impact: "high",
};

describe("detectPostNewsWindow", () => {
  it("fires inside the default 5-30 min window after a high-impact USD release", () => {
    const bars = [bar("2026-05-01T12:45:00Z")]; // 15 min after NFP
    const r = detectPostNewsWindow(bars, 0, { events: [NFP] });
    expect(r.detected).toBe(true);
    expect(r.details?.event_name).toBe("Non-Farm Employment Change");
    expect(r.details?.minutes_since_event).toBeCloseTo(15, 1);
  });

  it("does not fire before the min_minutes_after threshold", () => {
    const bars = [bar("2026-05-01T12:33:00Z")]; // 3 min after, default min is 5
    expect(detectPostNewsWindow(bars, 0, { events: [NFP] }).detected).toBe(false);
  });

  it("does not fire after the max_minutes_after threshold", () => {
    const bars = [bar("2026-05-01T13:05:00Z")]; // 35 min after, default max is 30
    expect(detectPostNewsWindow(bars, 0, { events: [NFP] }).detected).toBe(false);
  });

  it("respects custom min/max minutes", () => {
    const bars = [bar("2026-05-01T13:00:00Z")]; // 30 min after
    expect(
      detectPostNewsWindow(bars, 0, {
        events: [NFP],
        min_minutes_after: 25,
        max_minutes_after: 60,
      }).detected
    ).toBe(true);
  });

  it("filters out events below min_impact (default 'high')", () => {
    const bars = [bar("2026-05-01T12:45:00Z")];
    expect(detectPostNewsWindow(bars, 0, { events: [LOW_IMPACT] }).detected).toBe(false);
  });

  it("admits medium-impact events when min_impact is 'medium'", () => {
    const medium: EconomicEvent = { ...LOW_IMPACT, impact: "medium" };
    const bars = [bar("2026-05-01T12:45:00Z")];
    expect(
      detectPostNewsWindow(bars, 0, { events: [medium], min_impact: "medium" }).detected
    ).toBe(true);
  });

  it("filters by relevant_currencies when supplied", () => {
    const bars = [bar("2026-05-01T12:45:00Z")];
    expect(
      detectPostNewsWindow(bars, 0, {
        events: [EUR_EVENT],
        relevant_currencies: ["USD"],
      }).detected
    ).toBe(false);
    expect(
      detectPostNewsWindow(bars, 0, {
        events: [EUR_EVENT],
        relevant_currencies: ["EUR"],
      }).detected
    ).toBe(true);
  });

  it("returns false when no events are supplied", () => {
    const bars = [bar("2026-05-01T12:45:00Z")];
    expect(detectPostNewsWindow(bars, 0, { events: [] }).detected).toBe(false);
  });

  it("returns false for malformed bar timestamp", () => {
    const bars: PriceBar[] = [{ date: "garbage", open: 1, high: 1, low: 1, close: 1, volume: 0 }];
    expect(detectPostNewsWindow(bars, 0, { events: [NFP] }).detected).toBe(false);
  });
});
