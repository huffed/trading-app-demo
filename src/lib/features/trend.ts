/**
 * Trend / MA features — moving-average alignment, slopes, distances,
 * cross freshness.
 */
import { ema, sma } from "@/lib/market-data/indicators";
import type { Feature } from "./types";

function closesUpTo(bars: Parameters<Feature["compute"]>[0], idx: number): number[] {
  return bars.slice(0, idx + 1).map((b) => b.close);
}

const f_ema12_above_ema26: Feature = {
  name: "ema12_above_ema26",
  category: "trend",
  description: "1 if EMA(12) > EMA(26), else 0 (binary trend bias)",
  compute: (bars, idx) => {
    if (idx < 26) return null;
    const closes = closesUpTo(bars, idx);
    const e12 = ema(closes, 12)[idx];
    const e26 = ema(closes, 26)[idx];
    if (e12 == null || e26 == null) return null;
    return e12 > e26 ? 1 : 0;
  },
};

/** 0..3 count of "EMA12 > EMA26 > EMA50" alignment. 3 = full bullish stack;
 *  0 = full bearish (EMA12 < EMA26 < EMA50). Captures trend strength. */
const f_ema_alignment_score: Feature = {
  name: "ema_alignment_score",
  category: "trend",
  description: "0..3 count of EMA12>EMA26, EMA26>EMA50, close>EMA12 (bullish stack score)",
  compute: (bars, idx) => {
    if (idx < 50) return null;
    const closes = closesUpTo(bars, idx);
    const e12 = ema(closes, 12)[idx];
    const e26 = ema(closes, 26)[idx];
    const e50 = ema(closes, 50)[idx];
    const c = bars[idx]?.close;
    if (e12 == null || e26 == null || e50 == null || !c) return null;
    let score = 0;
    if (e12 > e26) score++;
    if (e26 > e50) score++;
    if (c > e12) score++;
    return score;
  },
};

const f_price_above_sma20: Feature = {
  name: "price_above_sma20",
  category: "trend",
  description: "1 if close > SMA(20), else 0",
  compute: (bars, idx) => {
    if (idx < 19) return null;
    const closes = closesUpTo(bars, idx);
    const s20 = sma(closes, 20)[idx];
    const c = bars[idx]?.close;
    if (s20 == null || !c) return null;
    return c > s20 ? 1 : 0;
  },
};

const f_sma20_slope: Feature = {
  name: "sma20_slope",
  category: "trend",
  description: "5-bar SMA(20) slope: (sma20 − sma20[5]) / sma20[5]",
  compute: (bars, idx) => {
    if (idx < 24) return null; // SMA20 needs idx >= 19; slope back-5 needs idx-5 >= 19
    const closes = closesUpTo(bars, idx);
    const s = sma(closes, 20);
    const cur = s[idx];
    const past = s[idx - 5];
    if (cur == null || past == null || past === 0) return null;
    return (cur - past) / past;
  },
};

const f_sma200_distance: Feature = {
  name: "sma200_distance",
  category: "trend",
  description: "Distance of close from SMA(200) as fraction: (close − sma200) / sma200",
  compute: (bars, idx) => {
    if (idx < 199) return null;
    const closes = closesUpTo(bars, idx);
    const s = sma(closes, 200)[idx];
    const c = bars[idx]?.close;
    if (s == null || !c || s === 0) return null;
    return (c - s) / s;
  },
};

/** Bars since the last EMA12/EMA26 crossover. NULL when no crossover in
 *  the visible history (or insufficient history). Capped at 500 for
 *  feature-importance comparability (a 500-bar-old crossover is
 *  effectively "long ago" for trading purposes). */
const f_ema_cross_freshness: Feature = {
  name: "ema_cross_freshness",
  category: "trend",
  description: "Bars since last EMA(12) / EMA(26) crossover (capped at 500)",
  compute: (bars, idx) => {
    if (idx < 27) return null;
    const closes = closesUpTo(bars, idx);
    const e12 = ema(closes, 12);
    const e26 = ema(closes, 26);
    const startSign = (e12[idx]! - e26[idx]!) > 0;
    const limit = Math.min(500, idx - 26);
    for (let back = 1; back <= limit; back++) {
      const j = idx - back;
      const a = e12[j];
      const b = e26[j];
      if (a == null || b == null) continue;
      const sign = (a - b) > 0;
      if (sign !== startSign) return back;
    }
    return limit;
  },
};

export const TREND_FEATURES: readonly Feature[] = [
  f_ema12_above_ema26,
  f_ema_alignment_score,
  f_price_above_sma20,
  f_sma20_slope,
  f_sma200_distance,
  f_ema_cross_freshness,
];
