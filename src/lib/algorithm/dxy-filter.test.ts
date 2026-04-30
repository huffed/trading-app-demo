import { describe, expect, it } from "vitest";
import { checkDxyDirection } from "./dxy-filter";
import type { PriceBar } from "@/lib/market-data/types";

// Build two bars where the close delta in pips is `deltaPips`. Lookback
// bar is exactly `lookbackHours` before the entry bar so the binary
// search picks them up unambiguously.
function buildBars(deltaPips: number, lookbackHours = 12): PriceBar[] {
  const entryClose = 1.1;
  const lookbackClose = entryClose - deltaPips / 10000;
  const entryTs = new Date("2026-04-30T12:00:00Z");
  const lookbackTs = new Date(entryTs.getTime() - lookbackHours * 3600 * 1000);
  const stub = (date: Date, close: number): PriceBar => ({
    date: date.toISOString(),
    open: close,
    high: close,
    low: close,
    close,
    volume: 0,
  });
  return [stub(lookbackTs, lookbackClose), stub(entryTs, entryClose)];
}

const ENTRY_TS = "2026-04-30T12:00:00Z";

describe("checkDxyDirection — disabled / no_data", () => {
  it("returns no_data when config.enabled=false", () => {
    const r = checkDxyDirection({
      side: "long",
      currentTimestamp: ENTRY_TS,
      proxyBars: buildBars(50),
      config: { enabled: false },
    });
    expect(r.block).toBe(false);
    expect(r.status).toBe("no_data");
  });

  it("returns no_data when proxyBars is empty", () => {
    const r = checkDxyDirection({
      side: "long",
      currentTimestamp: ENTRY_TS,
      proxyBars: [],
      config: { enabled: true },
    });
    expect(r.block).toBe(false);
    expect(r.status).toBe("no_data");
  });
});

describe("checkDxyDirection — bucket classification", () => {
  // +50 pips with side=long: EUR/USD up → DXY down → aligned with long gold
  it("classifies long + DXY-down as aligned", () => {
    const r = checkDxyDirection({
      side: "long",
      currentTimestamp: ENTRY_TS,
      proxyBars: buildBars(50),
      config: { enabled: true, mode: "block_against" },
    });
    expect(r.block).toBe(false);
    expect(r.status).toBe("aligned");
  });

  // -50 pips with side=long: DXY rising → against long gold
  it("classifies long + DXY-up as against", () => {
    const r = checkDxyDirection({
      side: "long",
      currentTimestamp: ENTRY_TS,
      proxyBars: buildBars(-50),
      config: { enabled: true, mode: "block_against" },
    });
    expect(r.block).toBe(true);
    expect(r.status).toBe("blocked");
  });

  // |delta| < 15 default threshold: neutral bucket
  it("classifies sub-threshold movement as neutral", () => {
    const r = checkDxyDirection({
      side: "long",
      currentTimestamp: ENTRY_TS,
      proxyBars: buildBars(5),
      config: { enabled: true, mode: "block_against" },
    });
    expect(r.block).toBe(false);
    expect(r.status).toBe("neutral");
  });
});

describe("checkDxyDirection — mode dispatch", () => {
  // block_against: only the against bucket triggers
  it("block_against blocks only against, passes aligned + neutral", () => {
    const cfg = { enabled: true, mode: "block_against" as const };
    expect(
      checkDxyDirection({
        side: "long",
        currentTimestamp: ENTRY_TS,
        proxyBars: buildBars(50),
        config: cfg,
      }).block
    ).toBe(false);
    expect(
      checkDxyDirection({
        side: "long",
        currentTimestamp: ENTRY_TS,
        proxyBars: buildBars(-50),
        config: cfg,
      }).block
    ).toBe(true);
    expect(
      checkDxyDirection({
        side: "long",
        currentTimestamp: ENTRY_TS,
        proxyBars: buildBars(5),
        config: cfg,
      }).block
    ).toBe(false);
  });

  // block_neutral_only: only the neutral bucket triggers — both
  // directional buckets pass through. "against" surfaces in status as
  // a pass-through bucket (the new state added with the mode field).
  it("block_neutral_only blocks only neutral, passes aligned + against", () => {
    const cfg = { enabled: true, mode: "block_neutral_only" as const };
    const aligned = checkDxyDirection({
      side: "long",
      currentTimestamp: ENTRY_TS,
      proxyBars: buildBars(50),
      config: cfg,
    });
    expect(aligned.block).toBe(false);
    expect(aligned.status).toBe("aligned");

    const against = checkDxyDirection({
      side: "long",
      currentTimestamp: ENTRY_TS,
      proxyBars: buildBars(-50),
      config: cfg,
    });
    expect(against.block).toBe(false);
    expect(against.status).toBe("against");

    const neutral = checkDxyDirection({
      side: "long",
      currentTimestamp: ENTRY_TS,
      proxyBars: buildBars(5),
      config: cfg,
    });
    expect(neutral.block).toBe(true);
    expect(neutral.status).toBe("blocked");
  });

  // block_against_and_neutral: only aligned passes
  it("block_against_and_neutral blocks against + neutral, passes aligned", () => {
    const cfg = { enabled: true, mode: "block_against_and_neutral" as const };
    expect(
      checkDxyDirection({
        side: "long",
        currentTimestamp: ENTRY_TS,
        proxyBars: buildBars(50),
        config: cfg,
      }).block
    ).toBe(false);
    expect(
      checkDxyDirection({
        side: "long",
        currentTimestamp: ENTRY_TS,
        proxyBars: buildBars(-50),
        config: cfg,
      }).block
    ).toBe(true);
    expect(
      checkDxyDirection({
        side: "long",
        currentTimestamp: ENTRY_TS,
        proxyBars: buildBars(5),
        config: cfg,
      }).block
    ).toBe(true);
  });
});

describe("checkDxyDirection — legacy block_neutral compat", () => {
  // mode unset + block_neutral=false → defaults to block_against
  it("legacy: no mode, block_neutral=false ⇒ block_against semantics", () => {
    const cfg = { enabled: true, block_neutral: false };
    expect(
      checkDxyDirection({
        side: "long",
        currentTimestamp: ENTRY_TS,
        proxyBars: buildBars(-50),
        config: cfg,
      }).block
    ).toBe(true);
    expect(
      checkDxyDirection({
        side: "long",
        currentTimestamp: ENTRY_TS,
        proxyBars: buildBars(5),
        config: cfg,
      }).block
    ).toBe(false);
  });

  // mode unset + block_neutral=true → defaults to block_against_and_neutral
  it("legacy: no mode, block_neutral=true ⇒ block_against_and_neutral semantics", () => {
    const cfg = { enabled: true, block_neutral: true };
    expect(
      checkDxyDirection({
        side: "long",
        currentTimestamp: ENTRY_TS,
        proxyBars: buildBars(50),
        config: cfg,
      }).block
    ).toBe(false);
    expect(
      checkDxyDirection({
        side: "long",
        currentTimestamp: ENTRY_TS,
        proxyBars: buildBars(-50),
        config: cfg,
      }).block
    ).toBe(true);
    expect(
      checkDxyDirection({
        side: "long",
        currentTimestamp: ENTRY_TS,
        proxyBars: buildBars(5),
        config: cfg,
      }).block
    ).toBe(true);
  });

  // mode wins when both are set
  it("explicit mode overrides legacy block_neutral", () => {
    const cfg = {
      enabled: true,
      mode: "block_neutral_only" as const,
      block_neutral: true,
    };
    // Against would block under block_against_and_neutral (the legacy
    // boolean's default), but should pass under explicit
    // block_neutral_only.
    const against = checkDxyDirection({
      side: "long",
      currentTimestamp: ENTRY_TS,
      proxyBars: buildBars(-50),
      config: cfg,
    });
    expect(against.block).toBe(false);
    expect(against.status).toBe("against");
  });
});

describe("checkDxyDirection — short side symmetry", () => {
  // Short gold: aligned when DXY is rising (delta < 0 → EUR/USD down)
  it("short + DXY-up classifies as aligned", () => {
    const r = checkDxyDirection({
      side: "short",
      currentTimestamp: ENTRY_TS,
      proxyBars: buildBars(-50),
      config: { enabled: true, mode: "block_against" },
    });
    expect(r.block).toBe(false);
    expect(r.status).toBe("aligned");
  });

  // Short gold: against when DXY is falling (delta > 0 → EUR/USD up)
  it("short + DXY-down classifies as against and blocks under block_against", () => {
    const r = checkDxyDirection({
      side: "short",
      currentTimestamp: ENTRY_TS,
      proxyBars: buildBars(50),
      config: { enabled: true, mode: "block_against" },
    });
    expect(r.block).toBe(true);
    expect(r.status).toBe("blocked");
  });
});
