/**
 * Fair Value Gap (FVG) detection. The 3-bar pattern at the heart of ICT
 * "imbalance" theory: when bar 1 and bar 3 don't overlap, bar 2 created
 * an imbalance the market is statistically biased to revisit.
 *
 *   Bullish FVG:  bar[i].high < bar[i+2].low   (gap up; demand zone created)
 *   Bearish FVG:  bar[i].low > bar[i+2].high   (gap down; supply zone created)
 *
 * The "Inverse FVG" (IFVG) is the same gap once price has filled it and
 * flipped its role. We model that as a separate fill-tracking step — a
 * gap is detected here, then the caller asks `wasFilled(gap, subsequent_bars)`.
 */
import type { PriceBar } from "@/lib/market-data/types";
import type { FvgDetails, PatternResult } from "./types";

/**
 * Detect an FVG anchored at the bar at `idx` (the middle bar of the
 * 3-bar pattern). Returns detected=false when there isn't a bar before
 * AND after, or when bar[i-1] and bar[i+1] overlap (no gap).
 */
export function detectFvg(bars: PriceBar[], idx: number): PatternResult<FvgDetails> {
  if (idx <= 0 || idx >= bars.length - 1) return { detected: false };
  const prev = bars[idx - 1];
  const next = bars[idx + 1];

  // Bullish FVG: previous bar's high is below next bar's low.
  if (prev.high < next.low) {
    return {
      detected: true,
      details: {
        direction: "bullish",
        gap_top: next.low,
        gap_bottom: prev.high,
        created_at_idx: idx,
      },
    };
  }

  // Bearish FVG: previous bar's low is above next bar's high.
  if (prev.low > next.high) {
    return {
      detected: true,
      details: {
        direction: "bearish",
        gap_top: prev.low,
        gap_bottom: next.high,
        created_at_idx: idx,
      },
    };
  }

  return { detected: false };
}

/**
 * Check whether a previously-detected FVG has been filled by subsequent
 * price action — defined as price re-entering the gap zone. Returns the
 * index of the bar that filled it, or null if still unfilled.
 */
export function fvgFillIndex(
  bars: PriceBar[],
  gap: FvgDetails,
  fromIdx: number = gap.created_at_idx + 2
): number | null {
  for (let i = Math.max(fromIdx, 0); i < bars.length; i++) {
    const b = bars[i];
    if (b.low <= gap.gap_top && b.high >= gap.gap_bottom) return i;
  }
  return null;
}

/**
 * Walk the bar series and return every FVG, with a `filled_at` field
 * recording when (or whether) each gap subsequently got filled. Useful
 * for backtesting confluence rules like "enter on IFVG retest" — the
 * IFVG signal is `gap.filled_at != null && current bar retests it`.
 */
export function scanFvgs(
  bars: PriceBar[]
): Array<{ gap: FvgDetails; filled_at: number | null }> {
  const out: Array<{ gap: FvgDetails; filled_at: number | null }> = [];
  for (let i = 1; i < bars.length - 1; i++) {
    const r = detectFvg(bars, i);
    if (!r.detected || !r.details) continue;
    const filled_at = fvgFillIndex(bars, r.details);
    out.push({ gap: r.details, filled_at });
  }
  return out;
}
