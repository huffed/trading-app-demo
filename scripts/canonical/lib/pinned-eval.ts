/**
 * Shared verdict-grade evaluation helpers for canonical scripts (E2.19.e).
 *
 * - loadPinnedBars: reads a pinned dataset file from scripts/canonical/data/
 *   and REFUSES to run on a sha256 mismatch. Verdict-grade runs use this,
 *   never the mutable live price_cache (memory: pinned-datasets-verdict-grade).
 * - soloStats / stressTest / dailySeries / pearson: the exact metric
 *   implementations first used by e2.20-rederivation.ts (kept there inline
 *   as frozen as-run evidence; extracted here for reuse by later scripts).
 *
 * FTMO stress semantics: Max Loss = FIXED floor vs initial balance
 * (feedback_ftmo_max_loss_is_fixed_floor), daily limit 5%, pass at +10%,
 * 60-day windows stepped 7 days.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { BacktestTrade, PriceBar } from "../../../src/lib/market-data/types";

export const POOL_CAPITAL = 10_000;
export const CHALLENGE_DAYS = 60;
export const STEP_DAYS = 7;

export function loadPinnedBars(ticker: string, gran: string): { bars: PriceBar[]; sha256: string } {
  const fname = `${ticker.replace("/", "-").toLowerCase()}-${gran.toLowerCase()}-pinned.json`;
  const path = resolve(process.cwd(), "scripts/canonical/data", fname);
  const { manifest, bars } = JSON.parse(readFileSync(path, "utf-8")) as {
    manifest: { sha256: string; bar_count: number };
    bars: PriceBar[];
  };
  const sha = createHash("sha256").update(JSON.stringify(bars)).digest("hex");
  if (sha !== manifest.sha256 || bars.length !== manifest.bar_count) {
    throw new Error(`pinned dataset integrity failure for ${fname} — refusing to run`);
  }
  return { bars, sha256: sha };
}

export interface SoloStats {
  trades: number;
  wr: number;
  static_dd_pct: number;
  daily_dd_pct: number;
  total_pnl: number;
  monthly_pct: number;
  passes_operator_bar: boolean;
}

/** Operator bar: n≥30, WR≥37, static DD≤10, daily DD≤5, pnl>0. */
export function soloStats(trades: BacktestTrade[], capital = POOL_CAPITAL): SoloStats {
  const sorted = [...trades].sort((a, b) => a.exit_date.localeCompare(b.exit_date));
  let equity = capital, peak = capital, maxDd = 0, wins = 0, total = 0;
  const daily = new Map<string, number>();
  for (const t of sorted) {
    equity += t.pnl;
    total += t.pnl;
    if (t.pnl > 0) wins++;
    if (equity > peak) peak = equity;
    const dd = ((peak - equity) / peak) * 100;
    if (dd > maxDd) maxDd = dd;
    const day = t.exit_date.slice(0, 10);
    daily.set(day, (daily.get(day) ?? 0) + t.pnl);
  }
  let worstDaily = 0;
  for (const p of daily.values()) if (p < 0 && Math.abs(p) > worstDaily) worstDaily = Math.abs(p);
  const dailyDd = (worstDaily / capital) * 100;
  const wr = trades.length ? (wins / trades.length) * 100 : 0;
  const spanDays = sorted.length >= 2
    ? (Date.parse(sorted[sorted.length - 1].exit_date) - Date.parse(sorted[0].entry_date)) / 86_400_000
    : 0;
  const monthly = spanDays > 30 ? (total / capital / (spanDays / 30.44)) * 100 : 0;
  return {
    trades: trades.length,
    wr,
    static_dd_pct: maxDd,
    daily_dd_pct: dailyDd,
    total_pnl: total,
    monthly_pct: monthly,
    passes_operator_bar: trades.length >= 30 && wr >= 37 && maxDd <= 10 && dailyDd <= 5 && total > 0,
  };
}

export interface StressResult {
  windows: number;
  pass: number;
  fail_ml: number;
  fail_dl: number;
  worst_ml: number;
  worst_dl: number;
  avg_return_pct: number;
}

export function stressTest(allTrades: BacktestTrade[], capital = POOL_CAPITAL): StressResult {
  const r: StressResult = { windows: 0, pass: 0, fail_ml: 0, fail_dl: 0, worst_ml: 0, worst_dl: 0, avg_return_pct: 0 };
  if (allTrades.length === 0) return r;
  const sorted = [...allTrades].sort((a, b) => a.exit_date.localeCompare(b.exit_date));
  const firstMs = Date.parse(sorted[0].exit_date);
  const lastMs = Date.parse(sorted[sorted.length - 1].exit_date);
  const dayMs = 86_400_000;
  let sumReturn = 0;
  for (let startMs = firstMs; startMs + CHALLENGE_DAYS * dayMs <= lastMs; startMs += STEP_DAYS * dayMs) {
    const endMs = startMs + CHALLENGE_DAYS * dayMs;
    let equity = capital, minEq = capital, profitHit = false, mlBreach = false;
    const daily = new Map<string, number>();
    for (const t of sorted) {
      const e = Date.parse(t.exit_date);
      if (e < startMs || e > endMs) continue;
      daily.set(t.exit_date.slice(0, 10), (daily.get(t.exit_date.slice(0, 10)) ?? 0) + t.pnl);
      equity += t.pnl;
      if (equity < minEq) minEq = equity;
      if (equity <= capital * 0.9) mlBreach = true;
      if (equity >= capital * 1.1) profitHit = true;
    }
    let worstDay = 0;
    for (const p of daily.values()) if (p < 0 && Math.abs(p) > worstDay) worstDay = Math.abs(p);
    const mlPct = Math.max(0, ((capital - minEq) / capital) * 100);
    const dlPct = (worstDay / capital) * 100;
    if (mlPct > r.worst_ml) r.worst_ml = mlPct;
    if (dlPct > r.worst_dl) r.worst_dl = dlPct;
    r.windows++;
    if (mlBreach) r.fail_ml++;
    else if (worstDay > capital * 0.05) r.fail_dl++;
    else if (profitHit) r.pass++;
    sumReturn += ((equity - capital) / capital) * 100;
  }
  r.avg_return_pct = r.windows ? sumReturn / r.windows : 0;
  return r;
}

export function dailySeries(trades: BacktestTrade[], firstMs: number, lastMs: number): number[] {
  const m = new Map<string, number>();
  for (const t of trades) m.set(t.exit_date.slice(0, 10), (m.get(t.exit_date.slice(0, 10)) ?? 0) + t.pnl);
  const out: number[] = [];
  for (let d = firstMs; d <= lastMs; d += 86_400_000) out.push(m.get(new Date(d).toISOString().slice(0, 10)) ?? 0);
  return out;
}

export function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  const ma = a.reduce((s, x) => s + x, 0) / n;
  const mb = b.reduce((s, x) => s + x, 0) / n;
  let num = 0, da2 = 0, db2 = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - ma, db = b[i] - mb;
    num += da * db;
    da2 += da * da;
    db2 += db * db;
  }
  const den = Math.sqrt(da2 * db2);
  return den === 0 ? 0 : num / den;
}
