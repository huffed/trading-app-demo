/**
 * Phase 3 periods (calendar years and quarters), the ten regime variables per
 * period, and the Pearson / Spearman correlation tables.
 */
import { mean, sd } from "./harness";
import { r2, r3, r4, pearson, spearman } from "./phase3-lib";
import type { Sess } from "./phase3-market";

export interface Period {
  key: string;
  from: string;
  to: string;
}
export function years(first: string, last: string): Period[] {
  const out: Period[] = [];
  for (let y = 2015; y <= 2026; y++) {
    const from = `${String(y)}-01-01T00:00:00.000Z`,
      to = `${String(y + 1)}-01-01T00:00:00.000Z`;
    if (to <= first || from > last) continue;
    out.push({ key: String(y), from, to: to > last ? last : to });
  }
  return out;
}
export function quarters(first: string, last: string): Period[] {
  const out: Period[] = [];
  for (let y = 2015; y <= 2026; y++) {
    for (let q = 0; q < 4; q++) {
      const from = new Date(Date.UTC(y, 3 * q, 1)).toISOString(),
        to = new Date(Date.UTC(y, 3 * q + 3, 1)).toISOString();
      if (to <= first || from > last) continue;
      out.push({ key: `${String(y)}Q${String(q + 1)}`, from, to: to > last ? last : to });
    }
  }
  return out;
}
export interface Regime {
  gold_ret_pct: number;
  bull_frac: number;
  flips: number;
  rv_ann_pct: number;
  atr_pct: number;
  eff_ratio: number;
  gold_mdd_pct: number;
  above_sma200_frac: number;
  sma50_slope_pct: number;
  adx14: number;
  sessions: number;
}
export const REGIME_KEYS: (keyof Regime)[] = [
  "gold_ret_pct",
  "bull_frac",
  "flips",
  "rv_ann_pct",
  "atr_pct",
  "eff_ratio",
  "gold_mdd_pct",
  "above_sma200_frac",
  "sma50_slope_pct",
  "adx14",
];
const NO_REGIME: Regime = {
  gold_ret_pct: NaN,
  bull_frac: NaN,
  flips: NaN,
  rv_ann_pct: NaN,
  atr_pct: NaN,
  eff_ratio: NaN,
  gold_mdd_pct: NaN,
  above_sma200_frac: NaN,
  sma50_slope_pct: NaN,
  adx14: NaN,
  sessions: 0,
};
interface Acc {
  flips: number;
  sumAbs: number;
  peak: number;
  mdd: number;
  bull: number;
  above: number;
  aboveN: number;
  lr: number[];
  atrp: number[];
  adx: number[];
}
function pushIndicators(a: Acc, x: Sess): void {
  if (!Number.isNaN(x.sma200)) {
    a.aboveN++;
    if (x.close > x.sma200) a.above++;
  }
  a.lr.push(x.logret);
  if (!Number.isNaN(x.atr14)) a.atrp.push(x.atr14 / x.close);
  if (!Number.isNaN(x.adx14)) a.adx.push(x.adx14);
}
const isFlip = (x: Sess, prev: Sess): boolean =>
  x.bias !== "neutral" && prev.bias !== "neutral" && x.bias !== prev.bias;
function accumulate(s: Sess[], idx: number[]): Acc {
  const a: Acc = {
    flips: 0,
    sumAbs: 0,
    peak: -Infinity,
    mdd: 0,
    bull: 0,
    above: 0,
    aboveN: 0,
    lr: [],
    atrp: [],
    adx: [],
  };
  for (const i of idx) {
    const x = s[i],
      prev = i > 0 ? s[i - 1] : x;
    if (i > idx[0] && isFlip(x, prev)) a.flips++;
    a.sumAbs += Math.abs(x.close - prev.close);
    a.peak = Math.max(a.peak, x.close);
    a.mdd = Math.max(a.mdd, (a.peak - x.close) / a.peak);
    if (x.bias === "bullish") a.bull++;
    pushIndicators(a, x);
  }
  return a;
}
/** Regime variables over the sessions whose close falls inside [from, to). */
export function regimeVars(s: Sess[], from: string, to: string): Regime {
  const idx = s.map((_, i) => i).filter((i) => s[i].date >= from && s[i].date < to);
  if (idx.length < 5) return { ...NO_REGIME, sessions: idx.length };
  const i0 = idx[0],
    i1 = idx[idx.length - 1],
    ref = i0 > 0 ? s[i0 - 1].close : s[i0].close;
  const a = accumulate(s, idx);
  const slope =
    Number.isNaN(s[i0].sma50) || Number.isNaN(s[i1].sma50)
      ? NaN
      : r2((100 * s[i1].sma50) / s[i0].sma50 - 100);
  return {
    gold_ret_pct: r2((100 * s[i1].close) / ref - 100),
    bull_frac: r3(a.bull / idx.length),
    flips: a.flips,
    rv_ann_pct: r2(100 * sd(a.lr) * Math.sqrt(252)),
    atr_pct: r4(mean(a.atrp)),
    eff_ratio: r3(a.sumAbs > 0 ? Math.abs(s[i1].close - ref) / a.sumAbs : 0),
    gold_mdd_pct: r2(100 * a.mdd),
    above_sma200_frac: a.aboveN ? r3(a.above / a.aboveN) : NaN,
    sma50_slope_pct: slope,
    adx14: a.adx.length ? r2(mean(a.adx)) : NaN,
    sessions: idx.length,
  };
}
export interface Corr {
  pearson: number;
  spearman: number;
  n_periods: number;
}
export function corrTable(
  rows: { regime: Regime; mean_r: number; n: number }[],
  minN: number
): Record<string, Corr> {
  const out: Record<string, Corr> = {};
  for (const k of REGIME_KEYS) {
    const pairs = rows.filter(
      (r) => r.n >= minN && Number.isFinite(r.regime[k]) && Number.isFinite(r.mean_r)
    );
    const a = pairs.map((r) => r.regime[k]),
      b = pairs.map((r) => r.mean_r);
    out[k] = { pearson: r3(pearson(a, b)), spearman: r3(spearman(a, b)), n_periods: pairs.length };
  }
  return out;
}
export function bestKey(c: Record<string, Corr>): string {
  return Object.entries(c).sort((x, y) => Math.abs(y[1].spearman) - Math.abs(x[1].spearman))[0][0];
}
