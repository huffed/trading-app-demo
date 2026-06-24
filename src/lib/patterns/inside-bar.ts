/**
 * Inside bar — continuation pattern where the current bar's range is
 * fully CONTAINED within the previous bar's range. Classic price-action
 * tell that the prior trend is consolidating before continuation (or
 * reversal if the break happens against the trend).
 *
 * Bullish inside bar: current bar inside previous bar AND previous bar
 *   was bullish (close > open). Signals continuation of the prior bull
 *   move pending break of the previous bar's high.
 *
 * Bearish inside bar: current bar inside previous bar AND previous bar
 *   was bearish. Signals continuation of the prior bear move pending
 *   break of the previous bar's low.
 *
 * Containment is strict: cur.high < prev.high AND cur.low > prev.low.
 * Equal highs / lows don't qualify (those are NR4-style consolidations,
 * a distinct pattern not handled here).
 */
import type { PriceBar } from "@/lib/market-data/types";
import type { PatternResult } from "./types";

export interface InsideBarDetails {
  direction: "bullish" | "bearish";
  /** Previous bar's range high — break target for continuation entry. */
  prev_high: number;
  /** Previous bar's range low — break target for reversal entry. */
  prev_low: number;
  /** Current bar's range, useful for stop-placement reasoning. */
  cur_high: number;
  cur_low: number;
}

export function detectInsideBar(
  bars: PriceBar[],
  idx: number,
): PatternResult<InsideBarDetails> {
  if (idx <= 0 || idx >= bars.length) return { detected: false };
  const prev = bars[idx - 1];
  const cur = bars[idx];
  // Strict containment — equal highs/lows don't qualify.
  if (!(cur.high < prev.high && cur.low > prev.low)) return { detected: false };
  const prevBull = prev.close > prev.open;
  const prevBear = prev.close < prev.open;
  if (!prevBull && !prevBear) return { detected: false }; // previous was a doji; ambiguous direction
  return {
    detected: true,
    details: {
      direction: prevBull ? "bullish" : "bearish",
      prev_high: prev.high,
      prev_low: prev.low,
      cur_high: cur.high,
      cur_low: cur.low,
    },
  };
}
