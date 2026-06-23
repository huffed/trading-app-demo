/**
 * Volatility features — ATR variants, realized vol, range expansion,
 * Bollinger width.
 */
import { atr14, pctile } from "@/lib/market-data/market-state";
import type { PriceBar } from "@/lib/market-data/types";
import type { Feature } from "./types";

const f_atr14: Feature = {
  name: "atr14",
  category: "volatility",
  description: "14-period Average True Range in price units",
  compute: (bars, idx) => atr14(bars, idx),
};

const f_atr14_pct: Feature = {
  name: "atr14_pct",
  category: "volatility",
  description: "ATR(14) as fraction of current close (vol normalised by price)",
  compute: (bars, idx) => {
    const a = atr14(bars, idx);
    const c = bars[idx]?.close;
    if (a == null || !c || c <= 0) return null;
    return a / c;
  },
};

/** ATR percentile over the last 200 bars. 0 = lowest vol seen; 100 = highest. */
const f_atr_percentile_200: Feature = {
  name: "atr_percentile_200",
  category: "volatility",
  description: "Current ATR(14) percentile (0..100) over trailing 200 bars",
  compute: (bars, idx) => {
    if (idx < 200) return null;
    const current = atr14(bars, idx);
    if (current == null) return null;
    const history: number[] = [];
    for (let j = idx - 199; j <= idx; j++) {
      const a = atr14(bars, j);
      if (a != null) history.push(a);
    }
    if (history.length < 50) return null;
    return pctile(history, current);
  },
};

/** Annualisation NOT applied — caller annualises if needed. Per-bar log-return stddev. */
const f_realized_vol_20: Feature = {
  name: "realized_vol_20",
  category: "volatility",
  description: "Stddev of last 20 log returns (per-bar; not annualised)",
  compute: (bars, idx) => {
    if (idx < 20) return null;
    const rets: number[] = [];
    for (let j = idx - 19; j <= idx; j++) {
      const c0 = bars[j - 1]?.close;
      const c1 = bars[j]?.close;
      if (!c0 || !c1 || c0 <= 0 || c1 <= 0) continue;
      rets.push(Math.log(c1 / c0));
    }
    if (rets.length < 2) return null;
    const mean = rets.reduce((s, x) => s + x, 0) / rets.length;
    const variance = rets.reduce((s, x) => s + (x - mean) * (x - mean), 0) / (rets.length - 1);
    return Math.sqrt(variance);
  },
};

const barRange = (b: PriceBar) => b.high - b.low;

const f_range_expansion_5: Feature = {
  name: "range_expansion_5",
  category: "volatility",
  description: "Current bar range / mean(last 5 bars range). >1 = expanding",
  compute: (bars, idx) => {
    if (idx < 5) return null;
    const cur = barRange(bars[idx]);
    let sum = 0;
    let n = 0;
    for (let j = idx - 5; j < idx; j++) {
      const r = barRange(bars[j]);
      if (r > 0) {
        sum += r;
        n++;
      }
    }
    if (n === 0 || sum === 0) return null;
    return cur / (sum / n);
  },
};

const f_range_contraction_5: Feature = {
  name: "range_contraction_5",
  category: "volatility",
  description: "Inverse of range_expansion_5 — mean prior range / current range. >1 = contracting",
  compute: (bars, idx) => {
    if (idx < 5) return null;
    const cur = barRange(bars[idx]);
    if (cur <= 0) return null;
    let sum = 0;
    let n = 0;
    for (let j = idx - 5; j < idx; j++) {
      const r = barRange(bars[j]);
      if (r > 0) {
        sum += r;
        n++;
      }
    }
    if (n === 0) return null;
    return sum / n / cur;
  },
};

const f_bb_width_20: Feature = {
  name: "bb_width_20",
  category: "volatility",
  description: "Bollinger Band width (upper − lower) / middle over 20 periods",
  compute: (bars, idx) => {
    const period = 20;
    if (idx < period - 1) return null;
    const slice = bars.slice(idx - period + 1, idx + 1).map((b) => b.close);
    const mean = slice.reduce((s, x) => s + x, 0) / period;
    const variance = slice.reduce((s, x) => s + (x - mean) * (x - mean), 0) / period;
    const sd = Math.sqrt(variance);
    if (mean === 0) return null;
    return (4 * sd) / mean; // (mean+2sd) − (mean−2sd) = 4sd; normalise by middle
  },
};

const f_atr_ratio_50: Feature = {
  name: "atr_ratio_50",
  category: "volatility",
  description: "ATR(14) / SMA(ATR, 50) — short-term vs long-term vol regime",
  compute: (bars, idx) => {
    const cur = atr14(bars, idx);
    if (cur == null) return null;
    if (idx < 50 + 14) return null;
    let sum = 0;
    let n = 0;
    for (let j = idx - 49; j <= idx; j++) {
      const a = atr14(bars, j);
      if (a != null) {
        sum += a;
        n++;
      }
    }
    if (n === 0 || sum === 0) return null;
    return cur / (sum / n);
  },
};

export const VOLATILITY_FEATURES: readonly Feature[] = [
  f_atr14,
  f_atr14_pct,
  f_atr_percentile_200,
  f_realized_vol_20,
  f_range_expansion_5,
  f_range_contraction_5,
  f_bb_width_20,
  f_atr_ratio_50,
];
