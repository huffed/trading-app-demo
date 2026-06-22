/**
 * CB.T1 Tier 3 — llm-trader-summarisers.ts (2026-06-23).
 *
 * Pure text summarisers for LLM context. Tests focus on regime
 * classification math + degenerate-input handling + "n/a" fallbacks
 * (don't pollute the prompt with malformed lines).
 */
import { describe, expect, it } from "vitest";
import type { PriceBar } from "@/lib/market-data/types";
import {
  computeAtr,
  summariseDailyBias,
  summariseDxy,
  summariseHigherTfStructure,
  summariseIntermarket,
  summarisePosition,
  summariseRecentBars,
} from "./llm-trader-summarisers";
import type { LlmTraderContext } from "./llm-trader";

function bar(close: number, high?: number, low?: number, open?: number, date = "2026-06-22T00:00:00Z"): PriceBar {
  return {
    date,
    open: open ?? close,
    high: high ?? close + 1,
    low: low ?? close - 1,
    close,
    volume: 0,
  };
}

function makeDays(n: number, increment = 0.5): PriceBar[] {
  return Array.from({ length: n }, (_, i) => bar(100 + i * increment));
}

describe("summariseDailyBias", () => {
  it("<21 bars → regime='n/a', summary='daily: n/a'", () => {
    const r = summariseDailyBias(makeDays(20));
    expect(r).toEqual({ summary: "daily: n/a", regime: "n/a" });
  });

  it("uptrend bars → regime='HH' (higher highs + higher lows)", () => {
    const r = summariseDailyBias(makeDays(25, 1.0));
    expect(r.regime).toBe("HH");
    expect(r.summary).toContain("D1 structure: HH");
  });

  it("downtrend bars → regime='LH'", () => {
    const r = summariseDailyBias(makeDays(25, -1.0));
    expect(r.regime).toBe("LH");
  });

  it("flat market → regime='RANGING'", () => {
    const bars = Array.from({ length: 25 }, () => bar(100));
    const r = summariseDailyBias(bars);
    expect(r.regime).toBe("RANGING");
  });
});

describe("computeAtr", () => {
  it("returns 0 on empty / out-of-bounds idx", () => {
    expect(computeAtr([], 14, 0)).toBe(0);
  });

  it("computes mean true range over the window", () => {
    const bars = Array.from({ length: 15 }, (_, i) => bar(100 + i, 105 + i, 95 + i));
    const atr = computeAtr(bars, 14, 14);
    expect(atr).toBeGreaterThan(0);
  });
});

describe("summariseRecentBars", () => {
  it("returns string with current price, 20-bar range, ATR14, last 3 bars", () => {
    const bars = makeDays(25, 1);
    const r = summariseRecentBars(bars, 20, "4h");
    expect(r).toContain("4h: cur");
    expect(r).toContain("ATR14");
    expect(r).toContain("Last 3 bars:");
  });
});

describe("summariseDxy", () => {
  it("null/empty bars → 'DXY: n/a'", () => {
    expect(summariseDxy(null, "2026-06-22T00:00:00Z")).toBe("DXY: n/a");
    expect(summariseDxy([], "2026-06-22T00:00:00Z")).toBe("DXY: n/a");
  });

  it("insufficient history (no bar before 7d cutoff) → 'DXY: n/a'", () => {
    const bars = [bar(1.05, undefined, undefined, undefined, "2026-06-22T00:00:00Z")];
    expect(summariseDxy(bars, "2026-06-22T01:00:00Z")).toBe("DXY: n/a");
  });

  it("sufficient history → returns DXY with 24h + 7d deltas", () => {
    const bars: PriceBar[] = [];
    for (let i = 0; i < 30; i++) {
      bars.push(bar(1.05 + i * 0.001, undefined, undefined, undefined, `2026-06-${String(i + 1).padStart(2, "0")}T00:00:00Z`));
    }
    const r = summariseDxy(bars, "2026-06-30T00:00:00Z");
    expect(r).toContain("DXY:");
    expect(r).toContain("24h");
    expect(r).toContain("7d");
  });
});

describe("summariseIntermarket", () => {
  it("undefined → 'Intermarket: n/a'", () => {
    expect(summariseIntermarket(undefined, 3050, "2026-06-22T00:00:00Z")).toBe("Intermarket: n/a");
  });

  it("empty parts (no usable series) → 'Intermarket: n/a'", () => {
    const r = summariseIntermarket({}, 3050, "2026-06-22T00:00:00Z");
    expect(r).toBe("Intermarket: n/a");
  });

  it("with all 3 series populated → parts joined with ' | '", () => {
    const series: PriceBar[] = [];
    for (let i = 0; i < 30; i++) {
      series.push(bar(30 + i * 0.1, undefined, undefined, undefined, `2026-06-${String(i + 1).padStart(2, "0")}T00:00:00Z`));
    }
    const r = summariseIntermarket(
      { silver: series, yield10y: series, vix: series },
      3050,
      "2026-06-30T00:00:00Z"
    );
    expect(r).toContain("XAU/XAG");
    expect(r).toContain("10Y");
    expect(r).toContain("VIX");
    expect(r).toContain(" | ");
  });
});

describe("summariseHigherTfStructure", () => {
  it("empty higherTfBars → '' (no line emitted)", () => {
    expect(summariseHigherTfStructure([], "2026-06-22T00:00:00Z")).toBe("");
  });

  it("populated → 'Higher TF: ...' format", () => {
    const bars = makeDays(20, 0.5);
    const higherTfBars: LlmTraderContext["higherTfBars"] = [{ tfLabel: "1h", bars }];
    const r = summariseHigherTfStructure(higherTfBars, "2026-06-22T00:00:00Z");
    expect(r).toContain("Higher TF:");
    expect(r).toContain("1h:");
  });
});

describe("summarisePosition", () => {
  it("null position → 'FLAT.'", () => {
    expect(summarisePosition(null, 3050)).toBe("FLAT.");
  });

  it("long position → includes side + P&L + SL/TP + R-multiple", () => {
    const pos = {
      side: "long" as const,
      entryPrice: 3000,
      stopPrice: 2980,
      targetPrice: 3060,
      initialStopPrice: 2980,
    };
    const r = summarisePosition(pos, 3030);
    expect(r).toContain("LONG from 3000");
    expect(r).toContain("cur 3030");
    expect(r).toContain("P&L +1.00%");
    expect(r).toContain("R +");
    expect(r).toContain("SL 2980");
    expect(r).toContain("TP 3060");
  });

  it("short position → side='SHORT', P&L inverted", () => {
    const pos = {
      side: "short" as const,
      entryPrice: 3000,
      stopPrice: 3020,
      targetPrice: 2940,
      initialStopPrice: 3020,
    };
    const r = summarisePosition(pos, 2970);
    expect(r).toContain("SHORT from 3000");
    expect(r).toContain("P&L +1.00%"); // (3000-2970)/3000 = +1%
  });

  it("missing stopPrice → 'SL n/a'", () => {
    const pos = {
      side: "long" as const,
      entryPrice: 3000,
      stopPrice: null,
      targetPrice: 3050,
      initialStopPrice: null,
    };
    const r = summarisePosition(pos, 3030);
    expect(r).toContain("SL n/a");
  });
});
