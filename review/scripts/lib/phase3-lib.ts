/**
 * Shared pieces of the Phase 3 scripts (phase3-regime.ts, phase3-stress.ts):
 * the rule transforms and the trade statistics. The market series live in
 * phase3-market.ts, the regime variables in phase3-regime-vars.ts.
 */
import { mean, nominalR } from "./harness";
import type { BacktestTrade } from "../../../src/lib/market-data/types";
import type { AlgorithmRules, EntryCondition } from "../../../src/types/algorithm";

export const CAP = 100_000;
export const RISK = 0.42;
export type Trade = BacktestTrade & { algo: string };
type Cond = EntryCondition & { pattern?: string; direction?: "bullish" | "bearish" };
type Conds = AlgorithmRules["entry_conditions"];

export function say(line: string): void {
  process.stdout.write(`${line}\n`);
}
export const r2 = (x: number): number => Math.round(x * 100) / 100;
export const r3 = (x: number): number => Math.round(x * 1000) / 1000;
export const r4 = (x: number): number => Math.round(x * 10000) / 10000;

// ---------- rule transforms ----------
const isBias = (c: Cond): boolean => c.pattern === "daily_bias";
export function withoutBias(r: AlgorithmRules): AlgorithmRules {
  const conds = (r.entry_conditions as Cond[]).filter((c) => !isBias(c));
  return { ...r, entry_conditions: conds as Conds };
}
export function mirrored(r: AlgorithmRules, keepBias: boolean): AlgorithmRules {
  const conds = (r.entry_conditions as Cond[])
    .filter((c) => keepBias || !isBias(c))
    .map((c) => (c.direction ? { ...c, direction: "bearish" as const } : c));
  return { ...r, side: "short", entry_conditions: conds as Conds };
}

// ---------- trade statistics ----------
export interface Brief {
  n: number;
  wr: number;
  mean_r: number;
  sum_r: number;
  pnl: number;
}
export const wr = (ts: BacktestTrade[]): number =>
  ts.length ? (100 * ts.filter((t) => t.pnl > 0).length) / ts.length : 0;
export function pf(ts: BacktestTrade[]): number {
  const w = ts.filter((t) => t.pnl > 0).reduce((a, t) => a + t.pnl, 0);
  const l = ts.filter((t) => t.pnl < 0).reduce((a, t) => a - t.pnl, 0);
  if (l > 0) return w / l;
  return ts.length ? Infinity : 0;
}
export const rOf = (t: BacktestTrade, cap = CAP, risk = RISK): number => nominalR(t, cap, risk);
export const sumR = (ts: BacktestTrade[]): number => ts.reduce((a, t) => a + rOf(t), 0);
export const meanR = (ts: BacktestTrade[]): number => (ts.length ? sumR(ts) / ts.length : 0);
export const pnl = (ts: BacktestTrade[]): number => ts.reduce((a, t) => a + t.pnl, 0);
export const brief = (ts: BacktestTrade[]): Brief => ({
  n: ts.length,
  wr: r2(wr(ts)),
  mean_r: r3(meanR(ts)),
  sum_r: r2(sumR(ts)),
  pnl: Math.round(pnl(ts)),
});
/** Max drawdown of the cumulative fixed-$CAP P&L path, in % of CAP (the Phase 2 method). */
export function maxDdPct(ts: BacktestTrade[], cap = CAP): number {
  let cum = 0,
    peak = 0,
    mdd = 0;
  for (const t of [...ts].sort((a, b) => a.exit_date.localeCompare(b.exit_date))) {
    cum += t.pnl;
    peak = Math.max(peak, cum);
    mdd = Math.max(mdd, peak - cum);
  }
  return (100 * mdd) / cap;
}
function rank(xs: number[]): number[] {
  const idx = xs.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0]);
  const r = new Array<number>(xs.length).fill(0);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
    i = j + 1;
  }
  return r;
}
export function pearson(a: number[], b: number[]): number {
  const n = a.length;
  if (n < 3) return NaN;
  const ma = mean(a),
    mb = mean(b);
  let num = 0,
    da2 = 0,
    db2 = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - ma,
      db = b[i] - mb;
    num += da * db;
    da2 += da * da;
    db2 += db * db;
  }
  const den = Math.sqrt(da2 * db2);
  return den === 0 ? NaN : num / den;
}
export const spearman = (a: number[], b: number[]): number => pearson(rank(a), rank(b));
