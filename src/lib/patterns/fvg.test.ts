import { describe, expect, it } from "vitest";
import { detectFvg } from "./fvg";
import { evaluatePatternCondition } from "./evaluate";
import type { PriceBar } from "@/lib/market-data/types";
import type { PatternCondition } from "@/types/algorithm";

function bar(date: string, o: number, h: number, l: number, c: number): PriceBar {
  return { date, open: o, high: h, low: l, close: c, volume: 0 };
}

/**
 * BULLISH FVG fixture:
 *   bars[0]: high=100  (pattern bar 1)
 *   bars[1]: low=102, high=105  (pattern bar 2 — the gap creator)
 *   bars[2]: low=103  (pattern bar 3 — confirming bar; low > bars[0].high)
 *
 * detectFvg should treat idx=1 as the middle bar and fire bullish.
 */
function makeBullishFvgFixture(): PriceBar[] {
  return [
    bar("2026-01-01", 99, 100, 98, 99),     // bar 0: high=100
    bar("2026-01-02", 100, 105, 102, 104),  // bar 1: middle (low=102 > 100)
    bar("2026-01-03", 104, 106, 103, 105),  // bar 2: confirming (low=103 > 100)
    bar("2026-01-04", 105, 107, 104, 106),  // bar 3: future (post-confirmation)
    bar("2026-01-05", 106, 108, 105, 107),  // bar 4: future
  ];
}

/** No FVG — bars 0 and 2 overlap. */
function makeNoFvgFixture(): PriceBar[] {
  return [
    bar("2026-01-01", 99, 102, 98, 100),    // high=102
    bar("2026-01-02", 100, 105, 99, 104),   // middle, low=99 ≤ 102 (overlaps)
    bar("2026-01-03", 104, 106, 101, 105),  // low=101 ≤ 102 (overlaps)
    bar("2026-01-04", 105, 107, 104, 106),
    bar("2026-01-05", 106, 108, 105, 107),
  ];
}

describe("detectFvg (raw detector)", () => {
  it("detects bullish FVG at the middle bar of the 3-bar pattern", () => {
    const bars = makeBullishFvgFixture();
    const r = detectFvg(bars, 1);
    expect(r.detected).toBe(true);
    expect(r.details?.direction).toBe("bullish");
    expect(r.details?.gap_bottom).toBe(100);
    expect(r.details?.gap_top).toBe(103);
    expect(r.details?.created_at_idx).toBe(1);
  });

  it("returns false when bars 0 and 2 overlap (no gap)", () => {
    const bars = makeNoFvgFixture();
    expect(detectFvg(bars, 1).detected).toBe(false);
  });

  it("guard: returns false at idx=0 (no prev bar)", () => {
    const bars = makeBullishFvgFixture();
    expect(detectFvg(bars, 0).detected).toBe(false);
  });

  it("guard: returns false when idx is the last bar (no next bar)", () => {
    const bars = makeBullishFvgFixture();
    expect(detectFvg(bars, bars.length - 1).detected).toBe(false);
  });
});

describe("evaluatePatternCondition for fvg (causal call-site)", () => {
  // The call-site fix: at evaluation idx, we ask "is bar idx the
  // CONFIRMING bar (third bar) of an FVG?" — so we anchor the detector
  // at idx-1 (the middle bar). This is what the 2026-06-18 fix shipped.

  const fvgCond: PatternCondition = { type: "pattern", pattern: "fvg", timeframe: "4h" };

  it("fires bullish at idx=2 (confirming bar) for the bullish fixture", () => {
    const bars = makeBullishFvgFixture();
    expect(evaluatePatternCondition(fvgCond, bars, 2)).toBe(true);
  });

  it("does NOT fire at idx=1 (middle bar) — that's pre-confirmation", () => {
    const bars = makeBullishFvgFixture();
    expect(evaluatePatternCondition(fvgCond, bars, 1)).toBe(false);
  });

  it("does NOT fire at idx=0 or idx=1 (guard: idx < 2)", () => {
    const bars = makeBullishFvgFixture();
    expect(evaluatePatternCondition(fvgCond, bars, 0)).toBe(false);
    expect(evaluatePatternCondition(fvgCond, bars, 1)).toBe(false);
  });

  it("direction filter: bullish FVG does NOT fire on direction=bearish", () => {
    const bars = makeBullishFvgFixture();
    const cond: PatternCondition = { type: "pattern", pattern: "fvg", direction: "bearish", timeframe: "4h" };
    expect(evaluatePatternCondition(cond, bars, 2)).toBe(false);
  });

  /**
   * THE LOOK-AHEAD TEST: cropping the bars array to just bars[0..2]
   * (the minimum the FVG needs to be confirmed) must produce the SAME
   * result as the full array. If the detector were reading future bars,
   * the cropped version would differ.
   */
  it("look-ahead test: cropping bars to confirmation point gives same result", () => {
    const fullBars = makeBullishFvgFixture();
    const croppedAtConfirmation = fullBars.slice(0, 3); // bars[0..2]
    expect(evaluatePatternCondition(fvgCond, fullBars, 2)).toBe(true);
    expect(evaluatePatternCondition(fvgCond, croppedAtConfirmation, 2)).toBe(true);
  });

  /**
   * The buggy pre-fix call-site did detectFvg(bars, idx). At idx=1
   * with the bullish fixture, the detector would read bars[2] (a future
   * bar) and fire. Post-fix at idx=1: detector is called with idx-1=0
   * which hits the guard idx<=0 → returns false. We assert the post-fix
   * behaviour: idx=1 returns false, idx=2 returns true.
   */
  it("post-fix: causal firing only on confirming bar, never on middle bar", () => {
    const bars = makeBullishFvgFixture();
    expect(evaluatePatternCondition(fvgCond, bars, 1)).toBe(false); // middle
    expect(evaluatePatternCondition(fvgCond, bars, 2)).toBe(true);  // confirming
    expect(evaluatePatternCondition(fvgCond, bars, 3)).toBe(false); // bar after; no NEW gap created at idx-1=2 (no gap between bars[1] and bars[3])
  });
});
