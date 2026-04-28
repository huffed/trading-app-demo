/**
 * Order Block (OB) — the last opposing candle before an impulsive move.
 *
 * Bullish OB: last DOWN-candle (close < open) immediately preceded by
 * a strong upward impulse. The OB's high/low define a support zone —
 * price often retests it as smart-money refilling orders, then resumes
 * upward.
 *
 * Bearish OB: mirror — last UP-candle before a downward impulse.
 *
 * Detection on bar `idx` returns true when the bar is currently TESTING
 * a previously-formed OB zone (i.e. price has come back into the
 * historical OB range from the impulse direction). This is the entry-
 * trigger interpretation; "detected the OB itself" would be too early
 * to act on.
 *
 * Impulse threshold: the move following the OB must be at least
 * `impulse_atr_multiple × ATR(14)` to qualify the OB as significant.
 * Filters out chop where every reversal qualifies as an "impulse".
 */
import type { PriceBar } from "@/lib/market-data/types";
import type { PatternResult } from "./types";

const DEFAULT_LOOKBACK = 30;
const DEFAULT_IMPULSE_ATR = 1.5;
const DEFAULT_ATR_PERIOD = 14;

export interface OrderBlockDetails {
  direction: "bullish" | "bearish";
  ob_idx: number;
  ob_high: number;
  ob_low: number;
  /** Distance of the impulse move (in price units) following the OB. */
  impulse_size: number;
}

interface CandidateOB {
  idx: number;
  high: number;
  low: number;
  direction: "bullish" | "bearish";
  impulseSize: number;
}

function atr(bars: PriceBar[], idx: number, period: number): number | null {
  if (idx < period) return null;
  let sum = 0;
  for (let i = idx - period + 1; i <= idx; i++) {
    if (i === 0) {
      sum += bars[i].high - bars[i].low;
      continue;
    }
    const prevClose = bars[i - 1].close;
    sum += Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - prevClose),
      Math.abs(bars[i].low - prevClose)
    );
  }
  return sum / period;
}

/** Find candidate OBs in the lookback window. A bullish OB candidate is
 *  a down-candle followed within 3 bars by a strong upward impulse;
 *  bearish mirror. Returns most recent candidates first. */
function findCandidates(
  bars: PriceBar[],
  idx: number,
  lookback: number,
  minImpulse: number
): CandidateOB[] {
  const out: CandidateOB[] = [];
  const start = Math.max(1, idx - lookback);
  for (let i = idx - 3; i >= start; i--) {
    const bar = bars[i];
    const isDown = bar.close < bar.open;
    const isUp = bar.close > bar.open;
    if (!isDown && !isUp) continue;
    // Look at the impulse over the next 1-3 bars.
    const followClose = bars[Math.min(i + 3, idx)].close;
    const move = followClose - bar.close;
    if (isDown && move >= minImpulse) {
      out.push({
        idx: i,
        high: bar.high,
        low: bar.low,
        direction: "bullish",
        impulseSize: move,
      });
    } else if (isUp && -move >= minImpulse) {
      out.push({
        idx: i,
        high: bar.high,
        low: bar.low,
        direction: "bearish",
        impulseSize: -move,
      });
    }
  }
  return out; // already in most-recent-first order
}

/**
 * Detect an OB-retest event on bar `idx`. Returns detected=true when
 * the current bar's range overlaps a prior bullish OB zone (and price
 * is approaching from above) or a bearish OB zone (approaching from
 * below).
 */
export function detectOrderBlock(
  bars: PriceBar[],
  idx: number,
  options: {
    lookback?: number;
    impulse_atr_multiple?: number;
    atr_period?: number;
  } = {}
): PatternResult<OrderBlockDetails> {
  const lookback = options.lookback ?? DEFAULT_LOOKBACK;
  const atrMul = options.impulse_atr_multiple ?? DEFAULT_IMPULSE_ATR;
  const atrPeriod = options.atr_period ?? DEFAULT_ATR_PERIOD;
  if (idx < atrPeriod || idx >= bars.length) return { detected: false };

  const a = atr(bars, idx, atrPeriod);
  if (a == null || a <= 0) return { detected: false };
  const minImpulse = a * atrMul;

  const candidates = findCandidates(bars, idx, lookback, minImpulse);
  if (candidates.length === 0) return { detected: false };

  const cur = bars[idx];
  for (const ob of candidates) {
    // Retest: current bar must overlap the OB zone. For a bullish OB
    // the price should ALSO be approaching from above (current low at
    // or below ob.high but not yet broken below ob.low).
    const overlapsZone = cur.low <= ob.high && cur.high >= ob.low;
    if (!overlapsZone) continue;
    if (ob.direction === "bullish" && cur.low > ob.low) {
      return {
        detected: true,
        details: {
          direction: "bullish",
          ob_idx: ob.idx,
          ob_high: ob.high,
          ob_low: ob.low,
          impulse_size: ob.impulseSize,
        },
      };
    }
    if (ob.direction === "bearish" && cur.high < ob.high) {
      return {
        detected: true,
        details: {
          direction: "bearish",
          ob_idx: ob.idx,
          ob_high: ob.high,
          ob_low: ob.low,
          impulse_size: ob.impulseSize,
        },
      };
    }
  }
  return { detected: false };
}
