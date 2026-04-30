/**
 * Asian range break detector — fires when the current bar breaks above
 * (bullish) or below (bearish) the high/low established during the Asian
 * session (UTC 00:00-07:00) of the same UTC date.
 *
 * Why: London-open breakout strategies use the Asian range as their
 * structural reference. The London session (06:00-10:00 UTC) historically
 * extends or reverses the Asian range; entering on a directional break
 * with confirmation captures the bulk of the continuation move.
 *
 * Sources: newyorkcityservers.com gold-XAUUSD strategy guide, fxnx.com
 * killzone series, ICT community documentation (research dump 2026-04-30).
 *
 * Detection:
 *   1. Walk back from `idx` collecting same-UTC-date bars whose hour < 7
 *      → compute Asian range high/low across those bars.
 *   2. Current bar (idx) must have hour >= 7 (Asian session has ended).
 *   3. Bullish break: bar.high > range_high AND bar.close > range_high.
 *      Bearish break: bar.low < range_low AND bar.close < range_low.
 *      Both wick AND close past the level — guards against pure-wick
 *      sweeps that fail to commit.
 *
 * Returns `{ detected: false }` when no Asian-session bars exist for the
 * current date (e.g., weekend, gap in data) — better to miss a setup than
 * fire on a degenerate range.
 */
import type { PriceBar } from "@/lib/market-data/types";
import type { PatternResult } from "./types";

export interface AsianRangeBreakDetails {
  direction: "bullish" | "bearish";
  range_high: number;
  range_low: number;
  /** range_high - range_low. Useful for diagnostics + size-relative checks. */
  range_width: number;
  /** Closing price of the breakout bar. */
  break_price: number;
  /** First Asian-session bar index considered. */
  asian_session_start_idx: number;
  /** Last Asian-session bar index considered. */
  asian_session_end_idx: number;
}

const ASIAN_SESSION_END_HOUR_UTC = 7;

export function detectAsianRangeBreak(
  bars: PriceBar[],
  idx: number
): PatternResult<AsianRangeBreakDetails> {
  const bar = bars[idx];
  if (!bar) return { detected: false };

  const barTs = Date.parse(bar.date);
  if (Number.isNaN(barTs)) return { detected: false };
  const barDate = new Date(barTs);
  const barHour = barDate.getUTCHours();
  if (barHour < ASIAN_SESSION_END_HOUR_UTC) return { detected: false };

  const targetDate = barDate.toISOString().slice(0, 10);

  let rangeHigh = -Infinity;
  let rangeLow = Infinity;
  let startIdx = -1;
  let endIdx = -1;

  for (let i = idx - 1; i >= 0; i--) {
    const b = bars[i];
    const t = Date.parse(b.date);
    if (Number.isNaN(t)) continue;
    const d = new Date(t);
    const dDate = d.toISOString().slice(0, 10);
    if (dDate !== targetDate) break;
    const dHour = d.getUTCHours();
    if (dHour >= ASIAN_SESSION_END_HOUR_UTC) continue;
    if (b.high > rangeHigh) rangeHigh = b.high;
    if (b.low < rangeLow) rangeLow = b.low;
    if (endIdx < 0) endIdx = i;
    startIdx = i;
  }

  if (startIdx < 0 || rangeHigh === -Infinity || rangeLow === Infinity) {
    return { detected: false };
  }

  const rangeWidth = rangeHigh - rangeLow;

  if (bar.high > rangeHigh && bar.close > rangeHigh) {
    return {
      detected: true,
      details: {
        direction: "bullish",
        range_high: Number(rangeHigh.toFixed(5)),
        range_low: Number(rangeLow.toFixed(5)),
        range_width: Number(rangeWidth.toFixed(5)),
        break_price: Number(bar.close.toFixed(5)),
        asian_session_start_idx: startIdx,
        asian_session_end_idx: endIdx,
      },
    };
  }

  if (bar.low < rangeLow && bar.close < rangeLow) {
    return {
      detected: true,
      details: {
        direction: "bearish",
        range_high: Number(rangeHigh.toFixed(5)),
        range_low: Number(rangeLow.toFixed(5)),
        range_width: Number(rangeWidth.toFixed(5)),
        break_price: Number(bar.close.toFixed(5)),
        asian_session_start_idx: startIdx,
        asian_session_end_idx: endIdx,
      },
    };
  }

  return { detected: false };
}
