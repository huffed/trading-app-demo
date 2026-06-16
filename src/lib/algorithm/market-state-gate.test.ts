import { describe, expect, it } from "vitest";
import type { MarketState } from "@/lib/market-data/market-state";
import type { PriceBar } from "@/lib/market-data/types";
import {
  checkMarketStateGate,
  computeEntryHourBucket,
  computeEntryZone,
  computePositionInRangePct,
  type MarketStateGate,
} from "./market-state-gate";
import { computeTpDistance, takeProfitRuleForSide } from "./structural-sl";

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

  // ----- entry_hour_bucket -----

  it("block mode refuses when entry_hour matches a blocked bucket", () => {
    const gate: MarketStateGate = {
      mode: "block",
      states: { entry_hour_bucket: ["late(21-24)"] },
    };
    const v = checkMarketStateGate(gate, STATE, { entryHourUtc: 22 });
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain("entry_hour_bucket=late(21-24)");
  });

  it("block mode passes when entry_hour falls in a different bucket", () => {
    const gate: MarketStateGate = {
      mode: "block",
      states: { entry_hour_bucket: ["late(21-24)"] },
    };
    expect(checkMarketStateGate(gate, STATE, { entryHourUtc: 14 }).allowed).toBe(true);
  });

  it("fails closed when entry_hour_bucket configured but ctx omits entryHourUtc", () => {
    const gate: MarketStateGate = {
      mode: "block",
      states: { entry_hour_bucket: ["late(21-24)"] },
    };
    const v = checkMarketStateGate(gate, STATE);
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain("entry_hour_bucket unreadable");
  });

  // ----- entry_zone -----

  it("block mode refuses when entry_zone derived from positionInRangePct hits the list", () => {
    const gate: MarketStateGate = {
      mode: "block",
      states: { entry_zone: ["premium"] },
    };
    // 80% → premium under V1 thresholds (≥67%)
    const v = checkMarketStateGate(gate, STATE, { positionInRangePct: 80 });
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain("entry_zone=premium");
  });

  it("entry_zone uses V1 thresholds (66% is equilibrium, 67% is premium)", () => {
    expect(computeEntryZone(33)).toBe("equilibrium");
    expect(computeEntryZone(32)).toBe("discount");
    expect(computeEntryZone(66)).toBe("equilibrium");
    expect(computeEntryZone(67)).toBe("premium");
    expect(computeEntryZone(null)).toBe("n/a");
  });

  it("entry_hour_bucket buckets match V1 (late = 21-24)", () => {
    expect(computeEntryHourBucket(0)).toBe("asia(0-7)");
    expect(computeEntryHourBucket(6)).toBe("asia(0-7)");
    expect(computeEntryHourBucket(7)).toBe("london(7-13)");
    expect(computeEntryHourBucket(12)).toBe("london(7-13)");
    expect(computeEntryHourBucket(13)).toBe("ny(13-21)");
    expect(computeEntryHourBucket(20)).toBe("ny(13-21)");
    expect(computeEntryHourBucket(21)).toBe("late(21-24)");
    expect(computeEntryHourBucket(23)).toBe("late(21-24)");
  });

  // ----- block_joint mode (the loser-cluster shape) -----

  it("block_joint refuses only when ALL configured features match (V1 cluster)", () => {
    const gate: MarketStateGate = {
      mode: "block_joint",
      states: {
        entry_hour_bucket: ["late(21-24)"],
        dxy: ["usd_flip"],
      },
    };
    // Both match: refuse.
    const refused = checkMarketStateGate(
      gate,
      { ...STATE, dxy: "usd_flip" },
      { entryHourUtc: 22 }
    );
    expect(refused.allowed).toBe(false);
    expect(refused.reason).toContain("joint block");
    expect(refused.reason).toContain("entry_hour_bucket=late(21-24)");
    expect(refused.reason).toContain("dxy=usd_flip");

    // Only hour matches: allow.
    expect(
      checkMarketStateGate(gate, { ...STATE, dxy: "usd_up" }, { entryHourUtc: 22 }).allowed
    ).toBe(true);

    // Only DXY matches: allow.
    expect(
      checkMarketStateGate(gate, { ...STATE, dxy: "usd_flip" }, { entryHourUtc: 14 }).allowed
    ).toBe(true);

    // Neither matches: allow.
    expect(
      checkMarketStateGate(gate, { ...STATE, dxy: "usd_up" }, { entryHourUtc: 14 }).allowed
    ).toBe(true);
  });

  it("block_joint with a single feature is equivalent to block", () => {
    const joint: MarketStateGate = {
      mode: "block_joint",
      states: { dxy: ["usd_up"] },
    };
    const block: MarketStateGate = {
      mode: "block",
      states: { dxy: ["usd_up"] },
    };
    expect(checkMarketStateGate(joint, STATE).allowed).toBe(false);
    expect(checkMarketStateGate(block, STATE).allowed).toBe(false);
  });

  // ----- shadow mode -----

  it("shadow mode keeps allowed=true but surfaces would-block reason", () => {
    const gate: MarketStateGate = {
      mode: "block",
      states: { dxy: ["usd_up"] },
      shadow: true,
    };
    const v = checkMarketStateGate(gate, STATE);
    expect(v.allowed).toBe(true);
    expect(v.shadow_block_reason).toContain("dxy=usd_up");
    expect(v.reason).toContain("shadow:");
  });

  it("shadow mode is a no-op when the gate would have allowed", () => {
    const gate: MarketStateGate = {
      mode: "block",
      states: { dxy: ["usd_down"] },
      shadow: true,
    };
    const v = checkMarketStateGate(gate, STATE);
    expect(v.allowed).toBe(true);
    expect(v.shadow_block_reason).toBeUndefined();
  });
});

describe("computePositionInRangePct", () => {
  const flatBars = (n: number, low: number, high: number) =>
    Array.from({ length: n }, (_, i) => ({
      high: i === 0 ? high : low + 1,
      low: i === n - 1 ? low : high - 1,
    }));

  it("returns null when bars are thin (<20)", () => {
    expect(computePositionInRangePct(flatBars(19, 100, 200), 150)).toBeNull();
  });

  it("returns 50 for a price at the midpoint of the 20-bar range", () => {
    const bars = flatBars(20, 100, 200);
    expect(computePositionInRangePct(bars, 150)).toBeCloseTo(50, 5);
  });

  it("clamps to [0, 100] when price drifts outside the range", () => {
    const bars = flatBars(20, 100, 200);
    expect(computePositionInRangePct(bars, 50)).toBe(0);
    expect(computePositionInRangePct(bars, 250)).toBe(100);
  });
});

// Co-located with the gate tests for convenience — both are small
// pure-resolver suites over rules shapes.

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


describe("computeTpDistance prior_day_extreme", () => {
  const daily: PriceBar[] = [
    { date: "2026-06-10", open: 4100, high: 4150, low: 4040, close: 4120, volume: 0 },
    { date: "2026-06-11", open: 4120, high: 4220, low: 4036, close: 4211, volume: 0 },
  ];
  const rule = { type: "prior_day_extreme" as const, value: 1.5 };

  it("short targets the previous UTC day's low", () => {
    // Entry 2026-06-12 → prior day 06-11, low 4036. Short from 4100 →
    // distance 64; SL 20 → level wins over floor.
    const d = computeTpDistance(rule, 20, 4100, undefined, undefined, {
      side: "short",
      entryDate: "2026-06-12 08:00:00",
      dailyBars: daily,
    });
    expect(d).toBeCloseTo(64, 6);
  });

  it("long targets the previous day's high", () => {
    const d = computeTpDistance(rule, 20, 4150, undefined, undefined, {
      side: "long",
      entryDate: "2026-06-12 08:00:00",
      dailyBars: daily,
    });
    expect(d).toBeCloseTo(70, 6); // 4220 − 4150
  });

  it("falls back to RR when the level is behind entry", () => {
    // Short from BELOW the prior low: 4036 level is above entry 4000 →
    // no valid target → fallback 1.5 × SL.
    const d = computeTpDistance(rule, 20, 4000, undefined, undefined, {
      side: "short",
      entryDate: "2026-06-12 08:00:00",
      dailyBars: daily,
    });
    expect(d).toBeCloseTo(30, 6);
  });

  it("falls back to RR without levelCtx", () => {
    expect(computeTpDistance(rule, 20, 4100, undefined)).toBeCloseTo(30, 6);
  });

  it("floors level distance at 1×SL", () => {
    // Level only 5 away but SL is 20 → floor wins.
    const d = computeTpDistance(rule, 20, 4041, undefined, undefined, {
      side: "short",
      entryDate: "2026-06-12 08:00:00",
      dailyBars: daily,
    });
    expect(d).toBeCloseTo(20, 6);
  });
});
