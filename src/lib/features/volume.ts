/**
 * Volume features. CAVEAT: forex/CFD bars often have synthetic / 0
 * volume (no centralised exchange). When volume = 0 across the
 * lookback window, these features return null — the feature is
 * uninformative for those instruments. Stock / crypto bars get real
 * volume + meaningful features.
 */
import type { Feature } from "./types";

const f_volume_ratio_20: Feature = {
  name: "volume_ratio_20",
  category: "volume",
  description: "Current bar volume / mean(last 20 bars volume). Null if all-zero.",
  compute: (bars, idx) => {
    if (idx < 20) return null;
    let sum = 0;
    let n = 0;
    for (let j = idx - 20; j < idx; j++) {
      const v = bars[j]?.volume;
      if (typeof v === "number" && v > 0) {
        sum += v;
        n++;
      }
    }
    if (n === 0 || sum === 0) return null;
    const cur = bars[idx]?.volume;
    if (typeof cur !== "number") return null;
    return cur / (sum / n);
  },
};

const f_volume_z_score_50: Feature = {
  name: "volume_z_score_50",
  category: "volume",
  description: "Z-score of current volume vs mean(50) / stddev(50). Null if degenerate.",
  compute: (bars, idx) => {
    if (idx < 50) return null;
    const vols: number[] = [];
    for (let j = idx - 49; j <= idx - 1; j++) {
      const v = bars[j]?.volume;
      if (typeof v === "number" && Number.isFinite(v)) vols.push(v);
    }
    if (vols.length < 2) return null;
    const mean = vols.reduce((s, x) => s + x, 0) / vols.length;
    const variance = vols.reduce((s, x) => s + (x - mean) * (x - mean), 0) / (vols.length - 1);
    const sd = Math.sqrt(variance);
    const cur = bars[idx]?.volume;
    if (sd === 0 || typeof cur !== "number") return null;
    return (cur - mean) / sd;
  },
};

export const VOLUME_FEATURES: readonly Feature[] = [f_volume_ratio_20, f_volume_z_score_50];
