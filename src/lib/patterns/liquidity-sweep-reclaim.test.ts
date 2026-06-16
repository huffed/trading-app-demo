import { describe, expect, it } from "vitest";
import { detectLiquiditySweepReclaim } from "./liquidity-sweep-reclaim";
import { detectLiquiditySweep } from "./liquidity-sweep";
import type { PriceBar } from "@/lib/market-data/types";

function bar(date: string, o: number, h: number, l: number, c: number): PriceBar {
  return { date, open: o, high: h, low: l, close: c, volume: 0 };
}

describe("detectLiquiditySweepReclaim", () => {
  // Confirm baseline: sweep detector recognises a sweep at the sweep
  // candle in our test fixture. If this fails, the test fixtures are
  // wrong (not the reclaim detector).
  it("sanity: raw detectLiquiditySweep fires on the sweep candle in test fixture", () => {
    const bars = makeBullishSweepFixture();
    const result = detectLiquiditySweep(bars, 10, 3);
    expect(result.detected).toBe(true);
    expect(result.details?.direction).toBe("bullish");
  });

  it("fires bullish on reclaim of swept swing low (the friend's EUR/USD pattern)", () => {
    // bars 0-4: forming swing low at bar 4 (low=100)
    // bars 5-9: bouncing back up (confirms bar 4 as swing low for lookback=5)
    // bar 10: SWEEP — wick to 98 (below 100 swing low), close 101.5 above
    // bar 11: stabilize
    // bar 12: RECLAIM — close 102.5 well above 100
    const bars = makeBullishSweepFixture();
    const result = detectLiquiditySweepReclaim(bars, 12, { lookback: 3, reclaim_window: 3 });
    expect(result.detected).toBe(true);
    expect(result.details?.direction).toBe("bullish");
    expect(result.details?.sweep_idx).toBe(10);
    expect(result.details?.reclaim_idx).toBe(12);
    expect(result.details?.bars_since_sweep).toBe(2);
  });

  it("fires bearish on reclaim of swept swing high", () => {
    const bars = makeBearishSweepFixture();
    const result = detectLiquiditySweepReclaim(bars, 12, { lookback: 3, reclaim_window: 3 });
    expect(result.detected).toBe(true);
    expect(result.details?.direction).toBe("bearish");
    expect(result.details?.sweep_idx).toBe(10);
    expect(result.details?.reclaim_idx).toBe(12);
  });

  it("does NOT fire when no recent sweep occurred", () => {
    const bars: PriceBar[] = Array.from({ length: 20 }, (_, i) =>
      bar(`2026-01-01 ${String(i).padStart(2, "0")}:00`, 100 + i, 100 + i + 1, 100 + i - 1, 100 + i)
    );
    const result = detectLiquiditySweepReclaim(bars, 19, { lookback: 3, reclaim_window: 3 });
    expect(result.detected).toBe(false);
  });

  it("does NOT fire when sweep happened but close didn't reclaim (still below swept level)", () => {
    const bars = makeBullishSweepFixture();
    // Replace bar 12 with a NON-reclaim (close stays below 100).
    bars[12] = bar("2026-01-01 12:00", 101.5, 102, 98, 99);
    const result = detectLiquiditySweepReclaim(bars, 12, { lookback: 3, reclaim_window: 3 });
    expect(result.detected).toBe(false);
  });

  it("does NOT fire when reclaim window is exceeded (sweep too old)", () => {
    const bars = makeBullishSweepFixture();
    // Add bars 13-16 to push the reclaim further away from the sweep.
    bars.push(bar("2026-01-01 13:00", 102.5, 103, 101, 102));
    bars.push(bar("2026-01-01 14:00", 102, 103, 101, 102));
    bars.push(bar("2026-01-01 15:00", 102, 103, 101, 102));
    bars.push(bar("2026-01-01 16:00", 102, 103, 101, 102.5));
    // Default reclaim_window=3. Sweep is at bar 10. Idx 16 is 6 bars away — too old.
    const result = detectLiquiditySweepReclaim(bars, 16, { lookback: 3, reclaim_window: 3 });
    expect(result.detected).toBe(false);

    // But with reclaim_window=10, sweep is within window — should fire.
    const result2 = detectLiquiditySweepReclaim(bars, 16, { lookback: 3, reclaim_window: 10 });
    expect(result2.detected).toBe(true);
  });

  it("does NOT fire on the sweep candle itself (degenerate same-bar case)", () => {
    const bars = makeBullishSweepFixture();
    // At bar 10 (the sweep candle), the detector scans bars 1..reclaim_window
    // BACK from idx — so it would look at bars 7-9, none of which contain
    // a sweep. This pins the "must be a separate bar" semantic.
    const result = detectLiquiditySweepReclaim(bars, 10, { lookback: 3, reclaim_window: 3 });
    expect(result.detected).toBe(false);
  });
});

// ---------- fixtures ----------

function makeBullishSweepFixture(): PriceBar[] {
  return [
    bar("2026-01-01 00:00", 110, 112, 105, 109), // 0
    bar("2026-01-01 01:00", 109, 110, 104, 108), // 1
    bar("2026-01-01 02:00", 108, 109, 103, 107), // 2
    bar("2026-01-01 03:00", 107, 108, 102, 106), // 3
    bar("2026-01-01 04:00", 106, 107, 100, 102), // 4 — SWING LOW (lowest of 0-9)
    bar("2026-01-01 05:00", 102, 105, 101.5, 104), // 5 — bounce, low > 100
    bar("2026-01-01 06:00", 104, 106, 102, 105), // 6
    bar("2026-01-01 07:00", 105, 107, 102.5, 106), // 7
    bar("2026-01-01 08:00", 106, 107, 102.5, 105), // 8
    bar("2026-01-01 09:00", 105, 106, 101.5, 103), // 9 — confirms bar 4 as swing low for lookback=5
    bar("2026-01-01 10:00", 103, 104, 98, 101.5), // 10 — SWEEP (low 98 < swing 100, close 101.5 > 100)
    bar("2026-01-01 11:00", 101.5, 102.5, 101, 102), // 11
    bar("2026-01-01 12:00", 102, 103, 101.5, 102.5), // 12 — RECLAIM (close 102.5 > 100)
  ];
}

function makeBearishSweepFixture(): PriceBar[] {
  return [
    bar("2026-01-01 00:00", 90, 95, 89, 91), // 0
    bar("2026-01-01 01:00", 91, 96, 90, 92), // 1
    bar("2026-01-01 02:00", 92, 97, 91, 93), // 2
    bar("2026-01-01 03:00", 93, 98, 92, 94), // 3
    bar("2026-01-01 04:00", 94, 100, 93, 98), // 4 — SWING HIGH at 100
    bar("2026-01-01 05:00", 98, 99.5, 95, 96), // 5
    bar("2026-01-01 06:00", 96, 98, 94, 95), // 6
    bar("2026-01-01 07:00", 95, 97.5, 94, 96), // 7
    bar("2026-01-01 08:00", 96, 97.5, 94, 95), // 8
    bar("2026-01-01 09:00", 95, 98.5, 94, 97), // 9 — confirms bar 4 as swing high
    bar("2026-01-01 10:00", 97, 102, 96, 98.5), // 10 — SWEEP (high 102 > 100, close 98.5 < 100)
    bar("2026-01-01 11:00", 98.5, 99, 97.5, 98), // 11
    bar("2026-01-01 12:00", 98, 99, 96, 97.5), // 12 — RECLAIM (close 97.5 < 100)
  ];
}
