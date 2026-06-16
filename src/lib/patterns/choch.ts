/**
 * Change of Character (ChoCh) — ICT/SMC trend-reversal signal.
 *
 * Distinct from BOS (Break of Structure) in one crucial way: BOS confirms
 * the CURRENT trend; ChoCh contradicts it. Mechanically they look the
 * same (price closes through a recent swing), but the prevailing-trend
 * test flips the interpretation:
 *
 *   - Uptrend = last two swing highs ascending (HH) AND last two swing
 *     lows ascending (HL). A close BELOW the most recent swing low is
 *     a bearish ChoCh: structure broke against the trend → potential
 *     reversal.
 *   - Downtrend = last two swing highs descending (LH) AND last two
 *     swing lows descending (LL). A close ABOVE the most recent swing
 *     high is a bullish ChoCh.
 *   - Mixed (one direction in highs, opposite in lows): no clear trend
 *     to break — never a ChoCh.
 *
 * Causal — only confirmed swings (±lookback past) feed the trend test.
 * Same bar `idx` in backtest replay returns the same answer as live.
 */
import type { PriceBar } from "@/lib/market-data/types";
import { detectSwingPoints } from "./swing-points";
import type { PatternResult } from "./types";

export interface ChochDetails {
  direction: "bullish" | "bearish";
  /** "uptrend" | "downtrend" — the trend that just broke. */
  prevailing_trend: "uptrend" | "downtrend";
  /** Swing level that the close broke through. */
  broken_level: number;
  /** Index of the broken swing. */
  broken_swing_idx: number;
  /** Bar `idx`'s close, the price that triggered the break. */
  break_close: number;
}

/**
 * Detect a ChoCh event AT BAR `idx`. Returns detected=true only when
 * (a) prevailing trend is unambiguous from the last two confirmed
 * swing highs + last two confirmed swing lows AND (b) `bars[idx]`'s
 * close strictly crosses the most recent confirmed swing in the
 * direction that contradicts the trend.
 *
 * Returns detected=false when fewer than two swings of either type
 * exist (warm-up) or when trend is mixed (no clear structure to break).
 */
export function detectChoch(
  bars: PriceBar[],
  idx: number,
  lookback: number = 5
): PatternResult<ChochDetails> {
  if (idx < lookback * 2 + 1 || idx >= bars.length) return { detected: false };
  const swings = detectSwingPoints(bars.slice(0, idx + 1), lookback);
  if (swings.length < 4) return { detected: false };

  // Collect the two most recent CONFIRMED highs and lows (idx ≤ idx-lookback).
  const recentHighs: { idx: number; price: number }[] = [];
  const recentLows: { idx: number; price: number }[] = [];
  for (let s = swings.length - 1; s >= 0; s--) {
    const sw = swings[s];
    if (sw.idx > idx - lookback) continue;
    if (sw.type === "high" && recentHighs.length < 2) {
      recentHighs.push({ idx: sw.idx, price: sw.price });
    } else if (sw.type === "low" && recentLows.length < 2) {
      recentLows.push({ idx: sw.idx, price: sw.price });
    }
    if (recentHighs.length >= 2 && recentLows.length >= 2) break;
  }
  if (recentHighs.length < 2 || recentLows.length < 2) return { detected: false };

  // recentHighs[0] is the most recent. recentHighs[1] is the previous.
  const highsAscending = recentHighs[0].price > recentHighs[1].price;
  const highsDescending = recentHighs[0].price < recentHighs[1].price;
  const lowsAscending = recentLows[0].price > recentLows[1].price;
  const lowsDescending = recentLows[0].price < recentLows[1].price;

  const close = bars[idx].close;

  // Uptrend: HH + HL. Bearish ChoCh = close below most recent swing low.
  if (highsAscending && lowsAscending && close < recentLows[0].price) {
    return {
      detected: true,
      details: {
        direction: "bearish",
        prevailing_trend: "uptrend",
        broken_level: recentLows[0].price,
        broken_swing_idx: recentLows[0].idx,
        break_close: close,
      },
    };
  }
  // Downtrend: LH + LL. Bullish ChoCh = close above most recent swing high.
  if (highsDescending && lowsDescending && close > recentHighs[0].price) {
    return {
      detected: true,
      details: {
        direction: "bullish",
        prevailing_trend: "downtrend",
        broken_level: recentHighs[0].price,
        broken_swing_idx: recentHighs[0].idx,
        break_close: close,
      },
    };
  }
  return { detected: false };
}
