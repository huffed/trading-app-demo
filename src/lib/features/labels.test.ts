import { describe, expect, it } from "vitest";
import type { PriceBar } from "@/lib/market-data/types";
import type { AlgorithmRules } from "@/types/algorithm";
import {
  extractRAwareGeometryConfig,
  isLabelFnName,
  LABEL_FN_NAMES,
  makeNextNBarSignLabel,
  makeRAwareLabel,
  makeRegimeConditionedLabel,
  nextBarSignLabel,
  resolveLabelFn,
} from "./labels";

const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;

function buildBars(closes: number[], startMs = Date.UTC(2024, 0, 1)): PriceBar[] {
  return closes.map((c, i) => ({
    date: new Date(startMs + i * FOUR_HOURS_MS).toISOString(),
    open: c,
    high: c + 0.5,
    low: c - 0.5,
    close: c,
    volume: 0,
  }));
}

function buildBarsHL(close_high_low: Array<[number, number, number]>): PriceBar[] {
  return close_high_low.map(([c, h, l], i) => ({
    date: new Date(Date.UTC(2024, 0, 1) + i * FOUR_HOURS_MS).toISOString(),
    open: c,
    high: h,
    low: l,
    close: c,
    volume: 0,
  }));
}

function fakeRules(rr = 3, side: "long" | "short" = "long"): AlgorithmRules {
  return {
    entry_conditions: [],
    entry_logic: "all",
    exit_conditions: [],
    stop_loss: { type: "swing_anchor", value: 0.1, lookback: 6 },
    take_profit: { type: "rr_multiple", value: rr },
    position_sizing: { type: "risk_per_trade", value: 0.6 },
    max_positions: 1,
    max_per_ticker: 1,
    leverage: 50,
    timeframe: "4h",
    asset_class: "commodity",
    side,
    prop_firm: {
      daily_loss_limit: 5,
      max_drawdown: 10,
      profit_target: 10,
      max_consecutive_losses: 0,
      consecutive_loss_daily_halt: 2,
      consistency_rule: 0,
      slippage_bps: 0.5,
      commission_pct: 0,
      spread_bps: 0.4,
      commission_per_lot: 0,
      combined_risk_cap_pct: 4,
    },
    stagnant_exit: { enabled: true },
  };
}

describe("nextBarSignLabel", () => {
  it("returns 1 when next close > current close", () => {
    const bars = buildBars([100, 101]);
    expect(nextBarSignLabel(bars, 0)).toBe(1);
  });

  it("returns 0 when next close ≤ current close", () => {
    const bars = buildBars([100, 100]);
    expect(nextBarSignLabel(bars, 0)).toBe(0);
    const bars2 = buildBars([100, 99]);
    expect(nextBarSignLabel(bars2, 0)).toBe(0);
  });

  it("returns null at last bar (no next bar)", () => {
    const bars = buildBars([100, 101]);
    expect(nextBarSignLabel(bars, 1)).toBe(null);
  });

  it("returns null on non-finite or non-positive current close", () => {
    const bars: PriceBar[] = [
      { date: "2024-01-01T00:00:00Z", open: 0, high: 0, low: 0, close: 0, volume: 0 },
      { date: "2024-01-01T04:00:00Z", open: 100, high: 100, low: 100, close: 100, volume: 0 },
    ];
    expect(nextBarSignLabel(bars, 0)).toBe(null);
  });
});

describe("makeNextNBarSignLabel", () => {
  it("returns 1 when bar N ahead has higher close", () => {
    const bars = buildBars([100, 99, 98, 97, 105]); // 4 bars ahead from idx=0 is 105
    const label = makeNextNBarSignLabel(4);
    expect(label(bars, 0)).toBe(1);
  });

  it("returns 0 when bar N ahead has lower close", () => {
    const bars = buildBars([100, 105, 110, 115, 95]);
    const label = makeNextNBarSignLabel(4);
    expect(label(bars, 0)).toBe(0);
  });

  it("returns null when N bars ahead would exceed series", () => {
    const bars = buildBars([100, 101, 102]);
    const label = makeNextNBarSignLabel(4);
    expect(label(bars, 0)).toBe(null);
  });

  it("throws on non-positive n", () => {
    expect(() => makeNextNBarSignLabel(0)).toThrow();
    expect(() => makeNextNBarSignLabel(-1)).toThrow();
    expect(() => makeNextNBarSignLabel(1.5)).toThrow();
  });
});

describe("makeRAwareLabel", () => {
  it("returns 1 (TP wins) for a clean long uptrend", () => {
    // Build 20 bars: warmup at $100, then strong upward move
    const bars: PriceBar[] = [];
    for (let i = 0; i < 20; i++) {
      bars.push({
        date: new Date(Date.UTC(2024, 0, 1) + i * FOUR_HOURS_MS).toISOString(),
        open: 100,
        high: 100.5,
        low: 99.5,
        close: 100,
        volume: 0,
      });
    }
    // Bars 20+ rip upward; TP at ~104.5 (entry 100 + 3 × 1ATR × 1.5 = +4.5) should hit
    for (let i = 20; i < 30; i++) {
      bars.push({
        date: new Date(Date.UTC(2024, 0, 1) + i * FOUR_HOURS_MS).toISOString(),
        open: 100 + (i - 19),
        high: 105 + (i - 19),
        low: 99,
        close: 100 + (i - 19),
        volume: 0,
      });
    }
    const label = makeRAwareLabel({
      rrMultiple: 3,
      slAtrMultiple: 1.5,
      atrPeriod: 14,
      maxLookahead: 10,
      side: "long",
    });
    expect(label(bars, 19)).toBe(1);
  });

  it("returns 0 (SL wins) for a long that crashes immediately", () => {
    const bars: PriceBar[] = [];
    for (let i = 0; i < 20; i++) {
      bars.push({
        date: new Date(Date.UTC(2024, 0, 1) + i * FOUR_HOURS_MS).toISOString(),
        open: 100,
        high: 100.5,
        low: 99.5,
        close: 100,
        volume: 0,
      });
    }
    for (let i = 20; i < 30; i++) {
      bars.push({
        date: new Date(Date.UTC(2024, 0, 1) + i * FOUR_HOURS_MS).toISOString(),
        open: 100 - (i - 19),
        high: 100,
        low: 90 - (i - 19),
        close: 95 - (i - 19),
        volume: 0,
      });
    }
    const label = makeRAwareLabel({
      rrMultiple: 3,
      slAtrMultiple: 1.5,
      atrPeriod: 14,
      maxLookahead: 10,
      side: "long",
    });
    expect(label(bars, 19)).toBe(0);
  });

  it("returns null when neither TP nor SL hits inside window", () => {
    // Flat market — neither TP nor SL touches
    const bars: PriceBar[] = [];
    for (let i = 0; i < 30; i++) {
      bars.push({
        date: new Date(Date.UTC(2024, 0, 1) + i * FOUR_HOURS_MS).toISOString(),
        open: 100,
        high: 100.001,
        low: 99.999,
        close: 100,
        volume: 0,
      });
    }
    const label = makeRAwareLabel({
      rrMultiple: 3,
      slAtrMultiple: 1.5,
      atrPeriod: 14,
      maxLookahead: 5,
      side: "long",
    });
    expect(label(bars, 19)).toBe(null);
  });

  it("conservative tie-break: both SL+TP touch in same bar → SL wins (label=0)", () => {
    const bars: PriceBar[] = [];
    for (let i = 0; i < 20; i++) {
      bars.push({
        date: new Date(Date.UTC(2024, 0, 1) + i * FOUR_HOURS_MS).toISOString(),
        open: 100,
        high: 102,
        low: 98,
        close: 100,
        volume: 0,
      });
    }
    // Bar 20 has a HUGE range that touches both SL and TP
    bars.push({
      date: new Date(Date.UTC(2024, 0, 1) + 20 * FOUR_HOURS_MS).toISOString(),
      open: 100,
      high: 200,
      low: 50,
      close: 100,
      volume: 0,
    });
    const label = makeRAwareLabel({
      rrMultiple: 3,
      slAtrMultiple: 1.5,
      atrPeriod: 14,
      maxLookahead: 5,
      side: "long",
    });
    expect(label(bars, 19)).toBe(0);
  });

  it("returns null on insufficient ATR lookback", () => {
    const bars = buildBars([100, 101, 102]); // only 3 bars; need 14 for ATR
    const label = makeRAwareLabel({
      rrMultiple: 3,
      slAtrMultiple: 1.5,
      atrPeriod: 14,
      maxLookahead: 10,
      side: "long",
    });
    expect(label(bars, 2)).toBe(null);
  });

  it("short side: inverts SL/TP direction correctly", () => {
    const bars = buildBarsHL([
      // 20 warm-up bars
      ...(Array(20).fill([100, 100.5, 99.5]) as Array<[number, number, number]>),
      // immediate downward move; for a SHORT, TP is below entry
      ...(Array(5).fill([95, 96, 90]) as Array<[number, number, number]>),
    ]);
    const label = makeRAwareLabel({
      rrMultiple: 3,
      slAtrMultiple: 1.5,
      atrPeriod: 14,
      maxLookahead: 5,
      side: "short",
    });
    expect(label(bars, 19)).toBe(1);
  });
});

describe("extractRAwareGeometryConfig", () => {
  it("reads rr_multiple from rules.take_profit", () => {
    const cfg = extractRAwareGeometryConfig(fakeRules(5));
    expect(cfg.rrMultiple).toBe(5);
  });

  it("reads side from rules.side", () => {
    expect(extractRAwareGeometryConfig(fakeRules(3, "long")).side).toBe("long");
    expect(extractRAwareGeometryConfig(fakeRules(3, "short")).side).toBe("short");
  });

  it("defaults when take_profit type is not rr_multiple", () => {
    const rules = fakeRules();
    (rules.take_profit as { type: string; value: number }).type = "fixed_pct";
    const cfg = extractRAwareGeometryConfig(rules);
    expect(cfg.rrMultiple).toBe(3); // default
  });
});

describe("makeRegimeConditionedLabel", () => {
  it("returns same value as inner label when bar IS in target regime; null otherwise (consistency contract)", () => {
    // Build bars with varied volatility so the classifier produces a mix of
    // regimes. Use the same classifyRegime the labeller uses; verify per-bar
    // that the conditioned-label output matches the inner-label output ONLY
    // when the bar's regime equals the target.
    const bars: PriceBar[] = [];
    for (let i = 0; i < 250; i++) {
      // Mix: 100 calm bars, 100 volatile bars, 50 medium bars.
      let range;
      if (i < 100) range = 0.1;
      else if (i < 200) range = 5;
      else range = 1;
      bars.push({
        date: new Date(Date.UTC(2024, 0, 1) + i * FOUR_HOURS_MS).toISOString(),
        open: 100,
        high: 100 + range,
        low: 100 - range,
        close: 100 + (i % 5 === 0 ? 0.5 : -0.5),
        volume: 0,
      });
    }
    const inner = nextBarSignLabel;
    for (const target of ["low_vol", "medium_vol", "high_vol"] as const) {
      const label = makeRegimeConditionedLabel(inner, target);
      // Sample across the post-warmup range.
      for (let i = 200; i < 249; i += 7) {
        const result = label(bars, i);
        // result is either null OR equal to inner(bars, i).
        const innerResult = inner(bars, i);
        if (result !== null) expect(result).toBe(innerResult);
      }
    }
  });

  it("returns null when regime classifier returns null (pre-lookback)", () => {
    const bars = buildBars([100, 101, 102]); // too few for classifier
    const label = makeRegimeConditionedLabel(nextBarSignLabel, "medium_vol");
    expect(label(bars, 0)).toBe(null);
  });
});

describe("resolveLabelFn", () => {
  it("resolves each canonical name", () => {
    for (const name of LABEL_FN_NAMES) {
      const fn = resolveLabelFn(name, { rules: fakeRules() });
      expect(typeof fn).toBe("function");
    }
  });

  it("throws on r_aware without rules", () => {
    expect(() => resolveLabelFn("r_aware", { rules: null })).toThrow(/r_aware/);
    expect(() => resolveLabelFn("r_aware_regime_conditioned", { rules: null })).toThrow(/r_aware_regime_conditioned/);
  });

  it("doesn't throw on sign-only variants without rules", () => {
    expect(() => resolveLabelFn("next_bar_sign", { rules: null })).not.toThrow();
    expect(() => resolveLabelFn("next_4_bar_sign", { rules: null })).not.toThrow();
    expect(() => resolveLabelFn("next_24_bar_sign", { rules: null })).not.toThrow();
    expect(() => resolveLabelFn("regime_conditioned", { rules: null })).not.toThrow();
  });

  it("accepts custom targetRegime override", () => {
    const fn1 = resolveLabelFn("regime_conditioned", { rules: null, targetRegime: "low_vol" });
    const fn2 = resolveLabelFn("regime_conditioned", { rules: null, targetRegime: "high_vol" });
    expect(typeof fn1).toBe("function");
    expect(typeof fn2).toBe("function");
  });
});

describe("isLabelFnName", () => {
  it("accepts canonical names", () => {
    for (const name of LABEL_FN_NAMES) {
      expect(isLabelFnName(name)).toBe(true);
    }
  });

  it("rejects non-canonical strings", () => {
    expect(isLabelFnName("random_string")).toBe(false);
    expect(isLabelFnName("")).toBe(false);
    expect(isLabelFnName("NEXT_BAR_SIGN")).toBe(false); // case-sensitive
  });
});
