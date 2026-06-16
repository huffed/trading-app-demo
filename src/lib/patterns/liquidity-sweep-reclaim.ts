/**
 * Liquidity sweep + reclaim detection — the discretionary variant where
 * the trader enters AFTER the sweep candle, on the confirmation candle
 * that closes back inside the swept range. This is distinct from the
 * raw `liquidity_sweep` detector which evaluates the sweep candle itself.
 *
 * Empirical motivation (2026-06-16 S1.5 #4 deep-dive): the friend's
 * sole signal-bearing zero-primitive trade (EUR/USD +$182, 200min hold)
 * matches this pattern exactly — a sweep at hour 08 (broke through
 * 1.145 round level + recent intraday low) followed by his entry at
 * hour 10 once price reclaimed back above 1.145. Our raw sweep detector
 * evaluating AT bar 10 sees no new sweep (bar 10's low is above bar 8's
 * swept low), so it misses the actual entry signal.
 *
 * The #245 sweep+reclaim kill was based on raw `liquidity_sweep` being
 * a loser-discriminator on his trades (0% winners / 13% losers at the
 * sweep candle). That stat was measured at the WRONG bar — his winners
 * enter at the RECLAIM candle which the raw detector doesn't catch.
 *
 *   Bullish reclaim: a sweep of a swing low happened within the last
 *     `reclaim_window` bars, AND current bar's close is back above the
 *     swept level (the level the sweep candle violated).
 *   Bearish reclaim: symmetric on the swing high side.
 *
 * Fires on the BAR THAT CLOSES THE RECLAIM, not on the sweep bar. This
 * is the entry timing the discretionary "sweep + reclaim" trader uses.
 */
import type { PriceBar } from "@/lib/market-data/types";
import { detectLiquiditySweep } from "./liquidity-sweep";
import type { LiquiditySweepDetails, PatternResult } from "./types";

export interface LiquiditySweepReclaimDetails {
  direction: "bullish" | "bearish";
  /** The swept level (swing low for bullish, swing high for bearish). */
  swept_level: number;
  /** Index of the sweep candle (the bar that violated the level). */
  sweep_idx: number;
  /** Index of the reclaim candle (the bar this detector fires on). */
  reclaim_idx: number;
  /** Bars between sweep and reclaim (0 if same bar — degenerate; usually 1-N). */
  bars_since_sweep: number;
}

/**
 * Detect sweep+reclaim at bar `idx`.
 *
 * - `lookback`: sweep detection lookback (passed through to detectLiquiditySweep).
 * - `reclaim_window`: how many bars back to scan for a recent sweep candle.
 *   Default 3 — friend's EUR/USD trade was a 2-bar gap (sweep at bar 8,
 *   reclaim at bar 10). Larger windows admit older sweeps; smaller
 *   windows require fresher reclaim timing.
 */
export function detectLiquiditySweepReclaim(
  bars: PriceBar[],
  idx: number,
  options: { lookback?: number; reclaim_window?: number } = {}
): PatternResult<LiquiditySweepReclaimDetails> {
  const lookback = options.lookback ?? 5;
  const reclaim_window = options.reclaim_window ?? 3;

  if (idx < lookback + reclaim_window) return { detected: false };

  const currentClose = bars[idx].close;

  // Scan recent bars (excluding current) for a sweep. First match wins;
  // a closer sweep is more relevant than an older one for reclaim timing.
  for (let back = 1; back <= reclaim_window; back++) {
    const sweepIdx = idx - back;
    const sweep = detectLiquiditySweep(bars, sweepIdx, lookback);
    if (!sweep.detected || !sweep.details) continue;
    const s = sweep.details as LiquiditySweepDetails;

    // Bullish reclaim — sweep was of a swing LOW; current close must be
    // back ABOVE the swept level (the level the sweep candle dipped
    // below and then closed back above on its own bar).
    if (s.direction === "bullish" && currentClose > s.swept_level) {
      return {
        detected: true,
        details: {
          direction: "bullish",
          swept_level: s.swept_level,
          sweep_idx: sweepIdx,
          reclaim_idx: idx,
          bars_since_sweep: back,
        },
      };
    }

    // Bearish reclaim — sweep was of a swing HIGH; current close must be
    // back BELOW the swept level.
    if (s.direction === "bearish" && currentClose < s.swept_level) {
      return {
        detected: true,
        details: {
          direction: "bearish",
          swept_level: s.swept_level,
          sweep_idx: sweepIdx,
          reclaim_idx: idx,
          bars_since_sweep: back,
        },
      };
    }
  }

  return { detected: false };
}
