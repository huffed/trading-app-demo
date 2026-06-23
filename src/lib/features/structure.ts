/**
 * Structure features — higher highs/lower lows, swing-extreme distances,
 * daily-bias agreement. Captures market-structure context (sweeps,
 * trend continuation, etc.) without invoking the full ICT pattern
 * detectors.
 */
import type { Feature } from "./types";

const f_higher_high_count_20: Feature = {
  name: "higher_high_count_20",
  category: "structure",
  description: "Count of bars (out of last 20) whose high exceeded the prior bar's high",
  compute: (bars, idx) => {
    if (idx < 20) return null;
    let count = 0;
    for (let j = idx - 19; j <= idx; j++) {
      if (j === 0) continue;
      if (bars[j].high > bars[j - 1].high) count++;
    }
    return count;
  },
};

const f_lower_low_count_20: Feature = {
  name: "lower_low_count_20",
  category: "structure",
  description: "Count of bars (out of last 20) whose low broke below the prior bar's low",
  compute: (bars, idx) => {
    if (idx < 20) return null;
    let count = 0;
    for (let j = idx - 19; j <= idx; j++) {
      if (j === 0) continue;
      if (bars[j].low < bars[j - 1].low) count++;
    }
    return count;
  },
};

/** Distance from recent swing high (over last 20 bars) to current close as
 *  fraction. Positive = swing-high above close (room to run); negative
 *  = current close above prior swing-high (in breakout territory). */
const f_swing_high_distance_pct: Feature = {
  name: "swing_high_distance_pct",
  category: "structure",
  description: "(swing-high last 20 bars − current close) / close — positive = below swing, negative = above",
  compute: (bars, idx) => {
    if (idx < 20) return null;
    let high = -Infinity;
    for (let j = idx - 19; j <= idx; j++) {
      if (bars[j].high > high) high = bars[j].high;
    }
    const c = bars[idx]?.close;
    if (!c || c <= 0 || !Number.isFinite(high)) return null;
    return (high - c) / c;
  },
};

const f_swing_low_distance_pct: Feature = {
  name: "swing_low_distance_pct",
  category: "structure",
  description: "(current close − swing-low last 20 bars) / close — positive = above swing, negative = below",
  compute: (bars, idx) => {
    if (idx < 20) return null;
    let low = Infinity;
    for (let j = idx - 19; j <= idx; j++) {
      if (bars[j].low < low) low = bars[j].low;
    }
    const c = bars[idx]?.close;
    if (!c || c <= 0 || !Number.isFinite(low)) return null;
    return (c - low) / c;
  },
};

/** D1 bias agreement: 1 if D1 close > D1 open AND current bar is bullish,
 *  or D1 close < D1 open AND current bar is bearish. 0 otherwise. Null
 *  when higherTfBars context not provided.
 *
 *  Uses the MOST-RECENT D1 bar from the higherTfBars context (caller is
 *  responsible for aligning the D1 series to the current primary bar's
 *  time — backtest passes the resampled series, scan passes the live
 *  D1 fetch). */
const f_daily_bias_agreement: Feature = {
  name: "daily_bias_agreement",
  category: "structure",
  description: "1 if current bar direction matches D1 bias (D1 close vs D1 open); 0 otherwise",
  compute: (bars, idx, ctx) => {
    const cur = bars[idx];
    if (!cur) return null;
    const hf = ctx?.higherTfBars;
    if (!hf || hf.length === 0) return null;
    const d1 = hf[hf.length - 1];
    if (!d1) return null;
    const curBullish = cur.close >= cur.open;
    const d1Bullish = d1.close >= d1.open;
    return curBullish === d1Bullish ? 1 : 0;
  },
};

export const STRUCTURE_FEATURES: readonly Feature[] = [
  f_higher_high_count_20,
  f_lower_low_count_20,
  f_swing_high_distance_pct,
  f_swing_low_distance_pct,
  f_daily_bias_agreement,
];
