/**
 * Optimal Trade Entry (OTE) — ICT fibonacci retracement zone.
 *
 * After an impulsive leg (low→high or high→low), price typically
 * retraces a portion of the move before continuing in the original
 * direction. The OTE zone is the 62%–79% retracement band — far
 * enough into the move that weak hands have shaken out, close enough
 * to the leg's origin that risk-to-reward is favourable.
 *
 *   - Bullish leg (swing low → swing high, high is more recent):
 *       leg_high - 0.79*range  ≤  OTE zone  ≤  leg_high - 0.62*range
 *     A close inside the zone after the leg ended is the buy signal.
 *   - Bearish leg (swing high → swing low, low is more recent):
 *       leg_low + 0.62*range  ≤  OTE zone  ≤  leg_low + 0.79*range
 *     A close inside the zone after the leg ended is the sell signal.
 *
 * Why bands matter: 62% and 79% are the fib levels closest to the
 * 70.5% "golden ratio square root" that ICT documentation singles out;
 * 50% is too shallow (often runs further); past 79% the leg is
 * arguably failing rather than retracing.
 *
 * Causal — uses only confirmed swings (±lookback past). The leg has
 * to have ENDED at a confirmed swing before OTE can fire, so the
 * detector can't trigger inside an in-progress leg.
 */
import type { PriceBar } from "@/lib/market-data/types";
import { detectSwingPoints } from "./swing-points";
import type { PatternResult } from "./types";

export interface OteDetails {
  direction: "bullish" | "bearish";
  /** Swing low that started (bullish) or ended (bearish) the leg. */
  leg_low: number;
  /** Swing high that ended (bullish) or started (bearish) the leg. */
  leg_high: number;
  /** Upper edge of the OTE zone (in price terms). */
  ote_top: number;
  /** Lower edge of the OTE zone. */
  ote_bottom: number;
  /** Where bars[idx].close sits, as a retracement percentage of the
   *  leg. 0 = at the leg's end, 100 = at the leg's origin. */
  retracement_pct: number;
}

const DEFAULT_FIB_LOW = 0.62;
const DEFAULT_FIB_HIGH = 0.79;

/**
 * Detect OTE retracement AT BAR `idx`. Returns detected=true only when
 * (a) the most recent confirmed swing pair forms an unambiguous leg
 * (one swing is clearly more recent) AND (b) `bars[idx]`'s close sits
 * inside the OTE band [62%, 79%] of that leg.
 *
 * Caller may override the fib bounds via `fibLow`/`fibHigh` for
 * tighter or looser variants. Defaults 0.62 / 0.79 are the ICT
 * standard.
 */
export function detectOte(
  bars: PriceBar[],
  idx: number,
  lookback: number = 5,
  fibLow: number = DEFAULT_FIB_LOW,
  fibHigh: number = DEFAULT_FIB_HIGH
): PatternResult<OteDetails> {
  if (idx < lookback * 2 + 1 || idx >= bars.length) return { detected: false };
  if (fibLow <= 0 || fibLow >= fibHigh || fibHigh >= 1) return { detected: false };
  const swings = detectSwingPoints(bars.slice(0, idx + 1), lookback);
  if (swings.length < 2) return { detected: false };

  // Most recent confirmed swing high + low.
  let recentHigh: { idx: number; price: number } | null = null;
  let recentLow: { idx: number; price: number } | null = null;
  for (let s = swings.length - 1; s >= 0; s--) {
    const sw = swings[s];
    if (sw.idx > idx - lookback) continue;
    if (!recentHigh && sw.type === "high") recentHigh = { idx: sw.idx, price: sw.price };
    if (!recentLow && sw.type === "low") recentLow = { idx: sw.idx, price: sw.price };
    if (recentHigh && recentLow) break;
  }
  if (!recentHigh || !recentLow) return { detected: false };
  if (recentHigh.price <= recentLow.price) return { detected: false };

  const close = bars[idx].close;
  const range = recentHigh.price - recentLow.price;

  // Bullish leg: high is more recent — buyers pushed up, now retracing
  // down into the OTE buy zone.
  if (recentHigh.idx > recentLow.idx) {
    const oteTop = recentHigh.price - fibLow * range;
    const oteBottom = recentHigh.price - fibHigh * range;
    if (close >= oteBottom && close <= oteTop) {
      const retracementPct = ((recentHigh.price - close) / range) * 100;
      return {
        detected: true,
        details: {
          direction: "bullish",
          leg_low: recentLow.price,
          leg_high: recentHigh.price,
          ote_top: oteTop,
          ote_bottom: oteBottom,
          retracement_pct: retracementPct,
        },
      };
    }
  }

  // Bearish leg: low is more recent — sellers pushed down, now
  // retracing up into the OTE sell zone.
  if (recentLow.idx > recentHigh.idx) {
    const oteBottom = recentLow.price + fibLow * range;
    const oteTop = recentLow.price + fibHigh * range;
    if (close >= oteBottom && close <= oteTop) {
      const retracementPct = ((close - recentLow.price) / range) * 100;
      return {
        detected: true,
        details: {
          direction: "bearish",
          leg_low: recentLow.price,
          leg_high: recentHigh.price,
          ote_top: oteTop,
          ote_bottom: oteBottom,
          retracement_pct: retracementPct,
        },
      };
    }
  }

  return { detected: false };
}
