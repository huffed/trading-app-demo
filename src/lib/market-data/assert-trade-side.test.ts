import { describe, expect, it } from "vitest";
import { assertTradeSidePopulated } from "./assert-trade-side";
import type { BacktestTrade } from "./types";

function makeTrade(side: BacktestTrade["side"] | undefined | null | "" | "longish"): BacktestTrade {
  return {
    entry_date: "2026-01-01",
    exit_date: "2026-01-02",
    entry_price: 100,
    exit_price: 105,
    pnl: 50,
    // @ts-expect-error — deliberately bypass type check for the negative tests
    side,
  };
}

describe("assertTradeSidePopulated (B.1.5)", () => {
  it("accepts side='long'", () => {
    expect(() => assertTradeSidePopulated(makeTrade("long"), "TestAlgo")).not.toThrow();
  });

  it("accepts side='short'", () => {
    expect(() => assertTradeSidePopulated(makeTrade("short"), "TestAlgo")).not.toThrow();
  });

  it("throws on undefined side with algo name + raw value in message", () => {
    expect(() => assertTradeSidePopulated(makeTrade(undefined), "TestAlgo"))
      .toThrowError(/TestAlgo.*undefined/);
  });

  it("throws on null side", () => {
    expect(() => assertTradeSidePopulated(makeTrade(null), "TestAlgo"))
      .toThrowError(/TestAlgo.*null/);
  });

  it("throws on empty string side", () => {
    expect(() => assertTradeSidePopulated(makeTrade(""), "TestAlgo"))
      .toThrow();
  });

  it("throws on garbage string side (defensive)", () => {
    expect(() => assertTradeSidePopulated(makeTrade("longish"), "TestAlgo"))
      .toThrow();
  });

  it("includes 'Engine side-population bug' diagnostic in the message", () => {
    expect(() => assertTradeSidePopulated(makeTrade(undefined), "TestAlgo"))
      .toThrowError(/Engine side-population bug/);
  });
});
