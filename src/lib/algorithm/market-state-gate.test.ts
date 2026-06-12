import { describe, expect, it } from "vitest";
import type { MarketState } from "@/lib/market-data/market-state";
import { checkMarketStateGate, type MarketStateGate } from "./market-state-gate";

const STATE: MarketState = { mtf: "fast_div_bear", vol: "mid", range: "compressed", dxy: "usd_up" };

describe("checkMarketStateGate", () => {
  it("allow mode passes when every configured feature matches", () => {
    const gate: MarketStateGate = {
      mode: "allow",
      states: { mtf: ["fast_div_bear"], vol: ["mid", "low"] },
    };
    expect(checkMarketStateGate(gate, STATE).allowed).toBe(true);
  });

  it("allow mode refuses when any configured feature misses (AND across features)", () => {
    const gate: MarketStateGate = {
      mode: "allow",
      states: { mtf: ["fast_div_bear"], vol: ["low"] },
    };
    const v = checkMarketStateGate(gate, STATE);
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain("vol=mid");
  });

  it("allow mode leaves unconfigured features unconstrained", () => {
    const gate: MarketStateGate = { mode: "allow", states: { range: ["compressed"] } };
    expect(checkMarketStateGate(gate, STATE).allowed).toBe(true);
  });

  it("block mode refuses when any configured feature matches its list", () => {
    const gate: MarketStateGate = {
      mode: "block",
      states: { mtf: ["fast_div_bull"], dxy: ["usd_up"] },
    };
    const v = checkMarketStateGate(gate, STATE);
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain("dxy=usd_up");
  });

  it("block mode passes when nothing matches", () => {
    const gate: MarketStateGate = {
      mode: "block",
      states: { mtf: ["fast_div_bull"], dxy: ["usd_down"] },
    };
    expect(checkMarketStateGate(gate, STATE).allowed).toBe(true);
  });

  it("fails closed on null state by default", () => {
    const gate: MarketStateGate = { mode: "allow", states: { vol: ["mid"] } };
    expect(checkMarketStateGate(gate, null).allowed).toBe(false);
  });

  it("fails closed on an n/a configured feature by default", () => {
    const gate: MarketStateGate = { mode: "allow", states: { mtf: ["aligned_HH"] } };
    const v = checkMarketStateGate(gate, { ...STATE, mtf: "n/a" });
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain("unreadable");
  });

  it("on_unreadable=allow lets unreadable state through", () => {
    const gate: MarketStateGate = {
      mode: "allow",
      states: { vol: ["mid"] },
      on_unreadable: "allow",
    };
    expect(checkMarketStateGate(gate, null).allowed).toBe(true);
  });

  it("ignores n/a in unconfigured features", () => {
    const gate: MarketStateGate = { mode: "allow", states: { vol: ["mid"] } };
    expect(checkMarketStateGate(gate, { ...STATE, mtf: "n/a" }).allowed).toBe(true);
  });

  it("treats an empty gate as pass-through", () => {
    const gate: MarketStateGate = { mode: "allow", states: {} };
    expect(checkMarketStateGate(gate, null).allowed).toBe(true);
  });
});

// Co-located with the gate tests for convenience — both are small
// pure-resolver suites over rules shapes.
import { takeProfitRuleForSide } from "./structural-sl";

describe("takeProfitRuleForSide", () => {
  const tp = { type: "rr_multiple" as const, value: 3 };
  const tpShort = { type: "rr_multiple" as const, value: 1.5 };

  it("longs always get the symmetric rule", () => {
    expect(takeProfitRuleForSide({ take_profit: tp, take_profit_short: tpShort }, "long")).toBe(tp);
  });

  it("shorts get the override when configured", () => {
    expect(takeProfitRuleForSide({ take_profit: tp, take_profit_short: tpShort }, "short")).toBe(
      tpShort
    );
  });

  it("shorts fall back to symmetric when no override", () => {
    expect(takeProfitRuleForSide({ take_profit: tp }, "short")).toBe(tp);
  });
});
