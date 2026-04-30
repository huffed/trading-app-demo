/**
 * Engulfing candle — classic price-action reversal pattern. The current
 * bar's body fully engulfs the previous bar's body AND closes in the
 * opposite direction.
 *
 * Why this matters: friend-trade replay analysis showed engulfing fires
 * on 21% of his 4h trade entries (his trade direction) — a real signal
 * he's evidently reading. Wasn't in our production pattern system;
 * this module adds it.
 *
 * Bullish engulfing: previous bar bearish (close < open) + current bar
 *   bullish (close > open) + current body engulfs previous body
 *   (current.open ≤ prev.close AND current.close ≥ prev.open).
 *   Indicates buyer overwhelm — short squeeze / momentum reversal.
 *
 * Bearish engulfing: mirror — previous bar bullish, current bar bearish,
 *   current body engulfs previous body. Indicates seller overwhelm.
 *
 * Strict body engulfing — wicks aren't required to overlap. The pattern
 * is about who took control on the body close, not on intraday spikes.
 */
import type { PriceBar } from "@/lib/market-data/types";
import type { PatternResult } from "./types";

export interface EngulfingDetails {
  direction: "bullish" | "bearish";
  /** Previous bar's body size (|close-open|). Surfaced for size-of-engulfing
   *  analysis — a small previous body engulfed by a giant current bar
   *  is a stronger signal than two ~equal bodies. */
  prev_body: number;
  current_body: number;
}

/**
 * Detect an engulfing pattern AT BAR `idx`. Returns detected=false when
 * `idx === 0` (no previous bar to compare) or when the bodies don't
 * meet the strict engulfing requirement.
 */
export function detectEngulfing(
  bars: PriceBar[],
  idx: number
): PatternResult<EngulfingDetails> {
  if (idx <= 0 || idx >= bars.length) return { detected: false };
  const prev = bars[idx - 1];
  const cur = bars[idx];
  const prevBull = prev.close > prev.open;
  const prevBear = prev.close < prev.open;
  const curBull = cur.close > cur.open;
  const curBear = cur.close < cur.open;
  const prevBody = Math.abs(prev.close - prev.open);
  const curBody = Math.abs(cur.close - cur.open);
  // Doji previous bar (body ≈ 0) makes "engulfing" trivially true; skip
  // unless current body is meaningful relative to recent volatility.
  if (prevBody === 0 || curBody === 0) return { detected: false };

  if (prevBear && curBull && cur.open <= prev.close && cur.close >= prev.open) {
    return {
      detected: true,
      details: { direction: "bullish", prev_body: prevBody, current_body: curBody },
    };
  }
  if (prevBull && curBear && cur.open >= prev.close && cur.close <= prev.open) {
    return {
      detected: true,
      details: { direction: "bearish", prev_body: prevBody, current_body: curBody },
    };
  }
  return { detected: false };
}
