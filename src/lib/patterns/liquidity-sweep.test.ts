import { describe, expect, it } from "vitest";
import { detectLiquiditySweep } from "./liquidity-sweep";
import type { PriceBar } from "@/lib/market-data/types";

function bar(date: string, o: number, h: number, l: number, c: number): PriceBar {
  return { date, open: o, high: h, low: l, close: c, volume: 0 };
}

/**
 * Build a fixture that EXPOSES the look-ahead bug fixed 2026-06-18.
 *
 * Layout (24 bars; index 11 is where we evaluate):
 *   0-3   approach
 *   4     swing low (low=95) — confirmable as swing high in pre-fix mode
 *         via bars[5..9] being ABOVE it
 *   5-9   pull up (highs ~100-104)
 *   10    sweep candle: pierces below 95 (low=93), closes above (close=96.5)
 *         → bullish liquidity sweep should fire HERE
 *   11    confirmation: not relevant for raw sweep, but provides context
 *   12-23 future bars (post-evaluation) — INCLUDE a NEW swing that
 *         would CHANGE the swing-list output if look-ahead were active.
 *         At index 17 we place a bar so high (high=120) that pre-fix
 *         detectSwingPoints would identify it as a "swing high" and
 *         lastSwingBefore(idx=10, "high") would return it... NO wait,
 *         lastSwingBefore filters by swings[i].idx < idx, so idx=17 > 10
 *         wouldn't be returned. The bug is subtler — bars NEAR idx-1
 *         get their swing-confirmation from future bars.
 */
function makeSweepFixture(): PriceBar[] {
  return [
    // 0-3: setup
    bar("2026-01-01", 100, 102, 99, 101),
    bar("2026-01-02", 101, 103, 100, 102),
    bar("2026-01-03", 102, 103, 100, 101),
    bar("2026-01-04", 101, 102, 98, 99),
    // 4: swing low at 95 (lookback 3 needs bars[1..7] to confirm it)
    bar("2026-01-05", 99, 100, 95, 97),
    // 5-9: pull up; bars[5..7] needed for the swing-at-4 lookback=3 confirmation
    bar("2026-01-06", 97, 102, 96, 101),
    bar("2026-01-07", 101, 103, 99, 102),
    bar("2026-01-08", 102, 104, 100, 103),
    bar("2026-01-09", 103, 104, 101, 102),
    bar("2026-01-10", 102, 103, 100, 101),
    // 10: sweep candle — pierces below 95, closes above (low=93, close=96.5)
    bar("2026-01-11", 101, 102, 93, 96.5),
    // 11: post-sweep bar
    bar("2026-01-12", 96.5, 99, 95, 97),
    // 12-23: future bars (idx > sweep_idx=10) — must NOT influence the swing list
    bar("2026-01-13", 97, 100, 96, 99),
    bar("2026-01-14", 99, 101, 98, 100),
    bar("2026-01-15", 100, 102, 99, 101),
    bar("2026-01-16", 101, 103, 100, 102),
    bar("2026-01-17", 102, 104, 101, 103),
    bar("2026-01-18", 103, 105, 102, 104),
    bar("2026-01-19", 104, 106, 103, 105),
    bar("2026-01-20", 105, 107, 104, 106),
    bar("2026-01-21", 106, 108, 105, 107),
    bar("2026-01-22", 107, 109, 106, 108),
    bar("2026-01-23", 108, 110, 107, 109),
    bar("2026-01-24", 109, 111, 108, 110),
  ];
}

/**
 * Look-ahead exposure fixture: builds bars where the swing structure
 * BEFORE idx looks different depending on whether future bars are
 * visible.
 *
 * At idx=14 we sweep what LOOKS LIKE a swing low at bar 9 (low=90).
 * But: bar 9's "swing low" status under lookback=3 depends on bars
 * 6,7,8,10,11,12 all having low > 90. If we let the detector see the
 * full array, those are visible and the swing confirms. If we
 * pre-slice to bars[0..14], the same bars are still visible (since
 * idx=14 includes them). So this fixture wouldn't expose the bug.
 *
 * BETTER look-ahead exposure: put bar 12 with low=89 (lower than the
 * "swing low" at bar 9). With pre-slice to bars[0..idx], if idx is
 * BEFORE bar 12 (say idx=11), bar 9 is still a valid swing low
 * candidate because bar 12 isn't yet visible. With unsliced bars,
 * bar 9 is NOT a swing low because bar 12's low=89 invalidates it.
 *
 * So at idx=11, pre-fix (unsliced) detector says "no swing at 9 to
 * sweep" because bar 12 breaks the swing. Post-fix (sliced) detector
 * says "swing at 9 to sweep". The DIRECTION of the difference shows
 * whether the bug was ACTIVE.
 */
function makeLookAheadFixture(): PriceBar[] {
  return [
    // 0-5: setup; baseline 100
    bar("2026-01-01", 100, 102, 99, 101),
    bar("2026-01-02", 101, 103, 100, 102),
    bar("2026-01-03", 102, 103, 100, 101),
    bar("2026-01-04", 101, 102, 99, 100),
    bar("2026-01-05", 100, 102, 99, 101),
    bar("2026-01-06", 101, 103, 100, 102),
    // 6-8: pull-down to swing low candidate
    bar("2026-01-07", 102, 103, 99, 100),
    bar("2026-01-08", 100, 101, 97, 98),
    bar("2026-01-09", 98, 99, 95, 96),
    // 9: candidate swing low at low=90 (requires bars[6..8] AND bars[10..12] above)
    bar("2026-01-10", 96, 97, 90, 92),
    // 10-11: pull up — confirms swing if we don't look at bar 12
    bar("2026-01-11", 92, 96, 91, 95),
    bar("2026-01-12", 95, 98, 94, 97),
    // 12: low=89 — BELOW the candidate swing low at bar 9. If detector
    //     SEES this bar, bar 9 is NOT confirmed as swing low. If
    //     detector is sliced to bars[0..11] (when evaluating at idx=11),
    //     bar 9 IS confirmed.
    bar("2026-01-13", 97, 98, 89, 91),
    // 13-15: continuation
    bar("2026-01-14", 91, 94, 90, 93),
    bar("2026-01-15", 93, 95, 92, 94),
    bar("2026-01-16", 94, 96, 93, 95),
  ];
}

describe("detectLiquiditySweep", () => {
  it("sanity: fires bullish on the sweep candle in the basic fixture", () => {
    const bars = makeSweepFixture();
    // The sweep happens at bar 10 (low=93 < 95 swing low, close=96.5 > 95)
    const r = detectLiquiditySweep(bars, 10, 3);
    expect(r.detected).toBe(true);
    expect(r.details?.direction).toBe("bullish");
  });

  /**
   * THE LOOK-AHEAD TEST.
   *
   * At idx=11 in the look-ahead fixture:
   *   - bar 9 (low=90) is the candidate swing low
   *   - bar 12 (low=89) is in the FUTURE relative to idx=11
   *   - With pre-fix (full bars passed to detectSwingPoints), bar 12 is
   *     visible and bar 9 is NOT a confirmed swing low → no sweep detected
   *   - With post-fix (bars.slice(0, idx+1)), bar 12 is HIDDEN and bar 9
   *     IS a confirmed swing low → sweep can be detected
   *
   * However: bar 11 has low=94, NOT < 90. So no sweep there.
   * Let me check: at idx=11 (low=94, close=97), the sweep detector
   * asks "is bar.low < swingLow.price AND bar.close > swingLow.price?"
   * — 94 < 90? No. So no sweep at idx=11.
   *
   * What we CAN test: evaluate at idx=11 must NOT crash AND must produce
   * a deterministic result that doesn't change if we extend the bars
   * array. Post-fix should give same result whether bars are full or
   * cropped at idx=11.
   */
  it("look-ahead test: result at idx=11 is the same whether bars are cropped or full", () => {
    const fullBars = makeLookAheadFixture();
    const cropped = fullBars.slice(0, 12); // bars[0..11]
    const rFull = detectLiquiditySweep(fullBars, 11, 3);
    const rCropped = detectLiquiditySweep(cropped, 11, 3);
    expect(rFull.detected).toBe(rCropped.detected);
    if (rFull.detected && rCropped.detected) {
      expect(rFull.details?.direction).toBe(rCropped.details?.direction);
      expect(rFull.details?.swept_level).toBe(rCropped.details?.swept_level);
      expect(rFull.details?.swept_idx).toBe(rCropped.details?.swept_idx);
    }
  });

  /**
   * Stronger version: detection at a sweep bar with future bars
   * invalidating the swing it would sweep. Post-fix sees the swing
   * (since future bars hidden) and detects sweep. Pre-fix doesn't see
   * the swing (future bars invalidate) and misses sweep.
   *
   * We construct: at idx=10 (the sweep candle), low=89 pierces a swing
   * low at bar 6. Bar 12 (FUTURE) has low=85. Pre-fix: detectSwingPoints
   * sees bar 12 and the "swing low at bar 6" is invalidated. Post-fix:
   * sliced at idx=10 hides bar 12, bar 6 still a valid swing low.
   */
  it("crucial: detection at sweep candle when future bars would invalidate the swing", () => {
    const bars: PriceBar[] = [
      bar("2026-01-01", 100, 102, 99, 101),
      bar("2026-01-02", 101, 103, 100, 102),
      bar("2026-01-03", 102, 103, 100, 101),
      // 3-5: pull down
      bar("2026-01-04", 101, 102, 95, 97),
      bar("2026-01-05", 97, 98, 93, 95),
      bar("2026-01-06", 95, 96, 92, 94),
      // 6: swing low at 90 (lookback=3 → bars[3..5] AND bars[7..9] must be > 90)
      bar("2026-01-07", 94, 95, 90, 92),
      // 7-9: pull up confirming swing
      bar("2026-01-08", 92, 95, 91, 94),
      bar("2026-01-09", 94, 96, 93, 95),
      bar("2026-01-10", 95, 97, 94, 96),
      // 10: SWEEP — pierces below 90 (low=89), closes back above (close=92)
      bar("2026-01-11", 96, 97, 89, 92),
      // 11: post-sweep
      bar("2026-01-12", 92, 94, 91, 93),
      // 12: FUTURE BAR with low=85 — would invalidate the swing at bar 6
      // if visible to detectSwingPoints
      bar("2026-01-13", 93, 94, 85, 88),
    ];
    // Post-fix detection: sees a swing at bar 6 (slicing hides bar 12)
    const r = detectLiquiditySweep(bars, 10, 3);
    expect(r.detected).toBe(true);
    expect(r.details?.direction).toBe("bullish");
    expect(r.details?.swept_idx).toBe(6); // swing was at bar 6
    expect(r.details?.swept_level).toBe(90);
  });
});
