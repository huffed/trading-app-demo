/**
 * Context features that require auxiliary inputs (FeatureContext):
 * calendar proximity, cross-asset correlation. Return null when the
 * required context is missing.
 */
import type { Feature } from "./types";

/** Bars (signed) since the most-recent tier-relevant event. Negative
 *  means an event is upcoming (negative magnitude = bars until next).
 *  When NO events present in context → returns null. Bar-cadence aware
 *  via the actual time delta between bars (uses the prior 5-bar median
 *  delta to convert ms → bars). */
const f_bars_since_news: Feature = {
  name: "bars_since_news",
  category: "context",
  description: "Signed bars since/until nearest economic event (positive=past, negative=upcoming); null if no events",
  compute: (bars, idx, ctx) => {
    const cur = bars[idx];
    if (!cur || !ctx?.events?.length) return null;
    const curMs = new Date(cur.date).getTime();
    // Compute bar duration from a 5-bar median delta (avoids fragility
    // to weekend gaps; defaults to 4h when insufficient history).
    let barDurationMs = 4 * 60 * 60 * 1000;
    if (idx >= 5) {
      const deltas: number[] = [];
      for (let j = idx - 4; j <= idx; j++) {
        const a = bars[j - 1]?.date;
        const b = bars[j]?.date;
        if (a && b) {
          const d = new Date(b).getTime() - new Date(a).getTime();
          if (d > 0) deltas.push(d);
        }
      }
      if (deltas.length > 0) {
        deltas.sort((a, b) => a - b);
        barDurationMs = deltas[Math.floor(deltas.length / 2)];
      }
    }
    let nearest: { ms: number; sign: number } | null = null;
    for (const e of ctx.events) {
      const evMs = new Date(e.time).getTime();
      if (!Number.isFinite(evMs)) continue;
      const delta = curMs - evMs; // positive = past, negative = upcoming
      const absDelta = Math.abs(delta);
      if (!nearest || absDelta < Math.abs(nearest.ms)) {
        nearest = { ms: delta, sign: Math.sign(delta) };
      }
    }
    if (!nearest) return null;
    return nearest.ms / barDurationMs;
  },
};

/** Pearson correlation of the last 20 closes' log-returns against the
 *  cross-asset's last 20 closes' log-returns. Null if cross-asset bars
 *  not provided OR fewer than 20 returns available. Aligns by INDEX
 *  (caller responsible for ensuring both series share a sample cadence;
 *  for live use, pass the cross-asset bars resampled to the algo's
 *  timeframe). */
const f_cross_asset_correlation_20: Feature = {
  name: "cross_asset_correlation_20",
  category: "context",
  description: "Pearson correlation of last 20 log-returns vs first cross-asset series in context",
  compute: (bars, idx, ctx) => {
    if (idx < 20) return null;
    const xa = ctx?.crossAssetBars;
    if (!xa || xa.size === 0) return null;
    const firstEntry = xa.values().next();
    if (firstEntry.done) return null;
    const otherBars = firstEntry.value;
    if (!otherBars || otherBars.length < idx + 1) return null;

    const myRets: number[] = [];
    const otherRets: number[] = [];
    for (let j = idx - 19; j <= idx; j++) {
      const c0 = bars[j - 1]?.close;
      const c1 = bars[j]?.close;
      const o0 = otherBars[j - 1]?.close;
      const o1 = otherBars[j]?.close;
      if (!c0 || !c1 || !o0 || !o1 || c0 <= 0 || o0 <= 0) continue;
      myRets.push(Math.log(c1 / c0));
      otherRets.push(Math.log(o1 / o0));
    }
    if (myRets.length < 5) return null;

    const meanA = myRets.reduce((s, x) => s + x, 0) / myRets.length;
    const meanB = otherRets.reduce((s, x) => s + x, 0) / otherRets.length;
    let num = 0;
    let sa = 0;
    let sb = 0;
    for (let i = 0; i < myRets.length; i++) {
      const da = myRets[i] - meanA;
      const db = otherRets[i] - meanB;
      num += da * db;
      sa += da * da;
      sb += db * db;
    }
    const denom = Math.sqrt(sa * sb);
    if (denom === 0) return null;
    return num / denom;
  },
};

/** Absolute value of cross_asset_correlation_20. Magnitude-only signal —
 *  high abs-corr means the two move together (either direction);
 *  near-zero means independent. Useful when the SIGN of correlation
 *  flips regime-by-regime but the MAGNITUDE is the informative axis. */
const f_cross_asset_correlation_abs_20: Feature = {
  name: "cross_asset_correlation_abs_20",
  category: "context",
  description: "Absolute value of cross_asset_correlation_20 (magnitude only, sign-invariant)",
  compute: (bars, idx, ctx) => {
    const r = f_cross_asset_correlation_20.compute(bars, idx, ctx);
    return r === null ? null : Math.abs(r);
  },
};

export const CONTEXT_FEATURES: readonly Feature[] = [
  f_bars_since_news,
  f_cross_asset_correlation_20,
  f_cross_asset_correlation_abs_20,
];
