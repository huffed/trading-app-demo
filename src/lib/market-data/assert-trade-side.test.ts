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

  // B.2.38 (Stage 3, 2026-06-19 EVE): switched from regex-substring matching
  // to structural assertions. The previous pattern `/TestAlgo.*undefined/`
  // would break on benign rewording (e.g. "for TestAlgo" → "of TestAlgo");
  // the contract we care about is "the error carries enough context to
  // identify which algo + what raw value caused it." Verify properties
  // explicitly rather than the exact word order.
  it("throws on undefined side; error carries algo name + a value marker", () => {
    let err: Error | null = null;
    try { assertTradeSidePopulated(makeTrade(undefined), "TestAlgo"); }
    catch (e) { err = e as Error; }
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toContain("TestAlgo");
    expect(err?.message).toMatch(/undefined|missing|empty/i);
  });

  it("throws on null side; error carries algo name + a value marker", () => {
    let err: Error | null = null;
    try { assertTradeSidePopulated(makeTrade(null), "TestAlgo"); }
    catch (e) { err = e as Error; }
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toContain("TestAlgo");
    expect(err?.message).toMatch(/null|missing|empty/i);
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
