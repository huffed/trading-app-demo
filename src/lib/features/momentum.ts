/**
 * Momentum features — RSI variants, ROC, MACD histogram.
 */
import { ema, macd, rsi } from "@/lib/market-data/indicators";
import type { Feature } from "./types";

function closesUpTo(bars: Parameters<Feature["compute"]>[0], idx: number): number[] {
  return bars.slice(0, idx + 1).map((b) => b.close);
}

const f_rsi14: Feature = {
  name: "rsi14",
  category: "momentum",
  description: "RSI 14-period",
  compute: (bars, idx) => {
    if (idx < 14) return null;
    return rsi(closesUpTo(bars, idx), 14)[idx];
  },
};

/** Distance from neutral. 0 = perfectly neutral; 50 = max extreme. */
const f_rsi14_extreme: Feature = {
  name: "rsi14_extreme",
  category: "momentum",
  description: "|RSI(14) − 50| — magnitude of overbought/oversold extreme",
  compute: (bars, idx) => {
    if (idx < 14) return null;
    const r = rsi(closesUpTo(bars, idx), 14)[idx];
    if (r == null) return null;
    return Math.abs(r - 50);
  },
};

const f_momentum_5: Feature = {
  name: "momentum_5",
  category: "momentum",
  description: "5-bar return (close − close[5]) / close[5]",
  compute: (bars, idx) => {
    if (idx < 5) return null;
    const cur = bars[idx]?.close;
    const past = bars[idx - 5]?.close;
    if (!cur || !past || past <= 0) return null;
    return (cur - past) / past;
  },
};

const f_momentum_20: Feature = {
  name: "momentum_20",
  category: "momentum",
  description: "20-bar return (close − close[20]) / close[20]",
  compute: (bars, idx) => {
    if (idx < 20) return null;
    const cur = bars[idx]?.close;
    const past = bars[idx - 20]?.close;
    if (!cur || !past || past <= 0) return null;
    return (cur - past) / past;
  },
};

const f_roc_10: Feature = {
  name: "roc_10",
  category: "momentum",
  description: "Rate of change over 10 bars — % from 10 bars ago",
  compute: (bars, idx) => {
    if (idx < 10) return null;
    const cur = bars[idx]?.close;
    const past = bars[idx - 10]?.close;
    if (!cur || !past || past <= 0) return null;
    return ((cur - past) / past) * 100;
  },
};

const f_macd_histogram: Feature = {
  name: "macd_histogram",
  category: "momentum",
  description: "MACD line (EMA12 − EMA26) minus signal (EMA9 of MACD line)",
  compute: (bars, idx) => {
    if (idx < 35) return null; // EMA26 + EMA9-of-MACD smoothing
    const closes = closesUpTo(bars, idx);
    const macdLine = macd(closes);
    const macdLineVals = macdLine.map((v) => v ?? 0);
    const signal = ema(macdLineVals, 9);
    const m = macdLine[idx];
    const s = signal[idx];
    if (m == null || s == null) return null;
    return m - s;
  },
};

export const MOMENTUM_FEATURES: readonly Feature[] = [
  f_rsi14,
  f_rsi14_extreme,
  f_momentum_5,
  f_momentum_20,
  f_roc_10,
  f_macd_histogram,
];
