/**
 * Phase 3 market series on the session dailies: the SMA20 bias the engine
 * uses, bias runs, and Wilder ATR14 / ADX14.
 */
import { mean } from "./harness";
import { r2 } from "./phase3-lib";
import type { PriceBar } from "../../../src/lib/market-data/types";

export type Bias = "bullish" | "bearish" | "neutral";
export interface Sess {
  date: string;
  close: number;
  bias: Bias;
  sma50: number;
  sma200: number;
  atr14: number;
  adx14: number;
  logret: number;
}
function sma(xs: number[], i: number, p: number): number {
  if (i + 1 < p) return NaN;
  let s = 0;
  for (let k = i - p + 1; k <= i; k++) s += xs[k];
  return s / p;
}
function biasOf(close: number, ma: number): Bias {
  if (Number.isNaN(ma) || close === ma) return "neutral";
  return close > ma ? "bullish" : "bearish";
}
interface DmBar {
  tr: number;
  pdm: number;
  mdm: number;
}
function dmBar(b: PriceBar, p: PriceBar): DmBar {
  const up = b.high - p.high,
    dn = p.low - b.low;
  return {
    tr: Math.max(b.high - b.low, Math.abs(b.high - p.close), Math.abs(b.low - p.close)),
    pdm: up > dn && up > 0 ? up : 0,
    mdm: dn > up && dn > 0 ? dn : 0,
  };
}
/** Wilder-smoothed DX → ADX; `dx` is the history so far, returns the new ADX (NaN until warm). */
function adxStep(dx: number[], prevAdx: number, P: number): number {
  if (dx.length < P) return NaN;
  if (dx.length === P) return mean(dx);
  return (prevAdx * (P - 1) + dx[dx.length - 1]) / P;
}
/** Wilder ATR14 and ADX14 on a bar series (NaN until warm). */
function wilder(bars: PriceBar[]): { atr: number[]; adx: number[] } {
  const P = 14,
    n = bars.length;
  const atr = new Array<number>(n).fill(NaN),
    adx = new Array<number>(n).fill(NaN);
  let sTr = 0,
    sP = 0,
    sM = 0,
    sAdx = NaN;
  const dx: number[] = [];
  for (let i = 1; i < n; i++) {
    const d = dmBar(bars[i], bars[i - 1]);
    const decay = i <= P ? 0 : 1 / P;
    sTr += d.tr - sTr * decay;
    sP += d.pdm - sP * decay;
    sM += d.mdm - sM * decay;
    if (i < P) continue;
    atr[i] = sTr / P;
    if (sTr <= 0) continue;
    const pdi = (100 * sP) / sTr,
      mdi = (100 * sM) / sTr;
    dx.push(pdi + mdi > 0 ? (100 * Math.abs(pdi - mdi)) / (pdi + mdi) : 0);
    sAdx = adxStep(dx, sAdx, P);
    adx[i] = sAdx;
  }
  return { atr, adx };
}
export function sessions(daily: PriceBar[]): Sess[] {
  const closes = daily.map((b) => b.close);
  const { atr, adx } = wilder(daily);
  return daily.map((b, i) => ({
    date: b.date,
    close: b.close,
    bias: biasOf(b.close, sma(closes, i, 20)),
    sma50: sma(closes, i, 50),
    sma200: sma(closes, i, 200),
    atr14: atr[i],
    adx14: adx[i],
    logret: i > 0 ? Math.log(b.close / closes[i - 1]) : 0,
  }));
}
export interface Run {
  bias: "bullish" | "bearish";
  start: string;
  end: string;
  sessions: number;
  gold_ret_pct: number;
  gold_mdd_pct: number;
  start_i: number;
  end_i: number;
}
export function biasRuns(s: Sess[]): Run[] {
  const runs: Run[] = [];
  let i = 0;
  while (i < s.length) {
    const bias = s[i].bias;
    if (bias === "neutral") {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < s.length && s[j + 1].bias === bias) j++;
    const ref = i > 0 ? s[i - 1].close : s[i].close;
    let peak = -Infinity,
      mdd = 0;
    for (let k = i; k <= j; k++) {
      peak = Math.max(peak, s[k].close);
      mdd = Math.max(mdd, (peak - s[k].close) / peak);
    }
    runs.push({
      bias,
      start: s[i].date,
      end: s[j].date,
      sessions: j - i + 1,
      gold_ret_pct: r2((100 * s[j].close) / ref - 100),
      gold_mdd_pct: r2(100 * mdd),
      start_i: i,
      end_i: j,
    });
    i = j + 1;
  }
  return runs;
}
/** Index of the last completed session at or before the instant `date` (what the engine sees); −1 if none. */
export function sessIdxAt(s: Sess[], date: string): number {
  let lo = 0,
    hi = s.length - 1,
    ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (s[mid].date <= date) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}
export interface RunPos {
  bias: Bias;
  age: number;
  total: number;
}
/** Per session: the bias, the age of its run (1 = the flip session) and the run's eventual length (hindsight). */
export function runPositions(s: Sess[], runs: Run[]): RunPos[] {
  const out: RunPos[] = s.map((x) => ({ bias: x.bias, age: 0, total: 0 }));
  for (const r of runs) {
    for (let i = r.start_i; i <= r.end_i; i++) {
      out[i] = { bias: r.bias, age: i - r.start_i + 1, total: r.sessions };
    }
  }
  return out;
}
