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

/** E2.24.d — a trade prepared for the fidelity stressTest: entry/exit day
 *  keys + pnl and MAE expressed as a RETURN on the equity they were sized
 *  on (de-compounding, E2.24.d.ii), ready to rescale to window-start
 *  capital. `maeRet` drives the floating-inclusive trough (E2.24.d.i). */
interface StressTrade {
  entryDayMs: number;
  exitDayMs: number;
  pnlRet: number;
  maeRet: number;
}

function dayFloor(ms: number): number {
  return Math.floor(ms / 86_400_000) * 86_400_000;
}

/**
 * E2.24.d fidelity upgrade. Two corrections over the realized-only original:
 *  - **De-compounding (d.ii):** trades were sized on compounding equity but
 *    each window is a fresh challenge at `capital`. Expressing pnl/MAE as a
 *    return on `equity_at_entry` and rescaling by `capital` removes the
 *    ~1.8× late-window inflation (exact to first order under RPT sizing;
 *    the compounding residual over a 60-day window is <0.1pp).
 *  - **Floating-inclusive trough (d.i):** FTMO judges FLOATING equity. For
 *    each day the conservative worst-case equity = realized-to-date −
 *    Σ(MAE of positions open that day). Both the static ML floor and the
 *    worst single-day drop are taken on this floating series, not the
 *    realized-only one. Up to ~2.6pp of concurrent floating DD was
 *    previously invisible.
 *
 * Auto-detects the fields: when trades carry `equity_at_entry` + `mae`
 * (portfolio engine) it runs the full model; otherwise it falls back to
 * the legacy realized-only behaviour (mae=0, pnl un-rescaled) so simple
 * callers are unaffected.
 */
export function stressTest(allTrades: BacktestTrade[], capital = POOL_CAPITAL): StressResult {
  const r: StressResult = { windows: 0, pass: 0, fail_ml: 0, fail_dl: 0, worst_ml: 0, worst_dl: 0, avg_return_pct: 0 };
  if (allTrades.length === 0) return r;

  // Prepare: return-on-entry-equity (de-compounded) + entry/exit day keys.
  const prepared: StressTrade[] = allTrades.map((t) => {
    const eqAtEntry = t.equity_at_entry != null && t.equity_at_entry > 0 ? t.equity_at_entry : capital;
    return {
      entryDayMs: dayFloor(Date.parse(t.entry_date)),
      exitDayMs: dayFloor(Date.parse(t.exit_date)),
      pnlRet: t.pnl / eqAtEntry,
      maeRet: (t.mae ?? 0) / eqAtEntry,
    };
  });
  prepared.sort((a, b) => a.exitDayMs - b.exitDayMs);
  // Window origin = earliest ENTRY (a challenge holds positions opened
  // within it); end = latest EXIT. Using earliest-exit would drop every
  // position that opened before its own window start.
  const firstMs = dayFloor(Math.min(...prepared.map((t) => t.entryDayMs)));
  const lastMs = dayFloor(Math.max(...prepared.map((t) => t.exitDayMs)));
  const dayMs = 86_400_000;

  let sumReturn = 0;
  for (let startMs = firstMs; startMs + CHALLENGE_DAYS * dayMs <= lastMs; startMs += STEP_DAYS * dayMs) {
    const endMs = startMs + CHALLENGE_DAYS * dayMs;
    // Trades whose EXIT lands in the window count toward realized pnl; a
    // fresh challenge only holds positions opened within it, so entries
    // before the window are ignored (their exit-in-window pnl is dropped
    // too — matches "the challenge starts here").
    const inWindow = prepared.filter((t) => t.exitDayMs >= startMs && t.exitDayMs <= endMs && t.entryDayMs >= startMs);
    if (inWindow.length === 0) { r.windows++; continue; }

    // Walk each day: floating equity = capital + realized(≤D) − Σ open MAE(D).
    let realized = 0; // running realized RETURN (fraction of capital)
    let minFloatEq = capital;
    let prevFloatEq = capital;
    let worstDayDrop = 0;
    let profitHit = false;
    const byExitDay = new Map<number, number>();
    for (const t of inWindow) byExitDay.set(t.exitDayMs, (byExitDay.get(t.exitDayMs) ?? 0) + t.pnlRet);

    for (let d = startMs; d <= endMs; d += dayMs) {
      realized += byExitDay.get(d) ?? 0;
      // Sum MAE of positions open at end of day d (entered ≤ d, exit > d).
      let openMaeRet = 0;
      for (const t of inWindow) {
        if (t.entryDayMs <= d && t.exitDayMs > d) openMaeRet += t.maeRet;
      }
      const realizedEq = capital + realized * capital;
      const floatEq = realizedEq - openMaeRet * capital; // conservative floating trough
      if (floatEq < minFloatEq) minFloatEq = floatEq;
      const drop = prevFloatEq - floatEq;
      if (drop > worstDayDrop) worstDayDrop = drop;
      prevFloatEq = floatEq;
      if (realizedEq >= capital * 1.1) profitHit = true; // pass on realized +10%
    }

    const mlPct = Math.max(0, ((capital - minFloatEq) / capital) * 100);
    const dlPct = (worstDayDrop / capital) * 100;
    if (mlPct > r.worst_ml) r.worst_ml = mlPct;
    if (dlPct > r.worst_dl) r.worst_dl = dlPct;
    r.windows++;
    if (mlPct >= 10) r.fail_ml++;
    else if (dlPct > 5) r.fail_dl++;
    else if (profitHit) r.pass++;
    sumReturn += realized * 100; // realized return %, de-compounded
  }
  r.avg_return_pct = r.windows ? sumReturn / r.windows : 0;
  return r;
}

export interface ChallengeResult {
  starts: number;
  resolved: number;
  passes: number;
  fails_ml: number;
  fails_dl: number;
  unresolved: number;
  /** P(pass) over RESOLVED challenges only — the honest FTMO number (no
   *  time limit, so a challenge runs until it hits +10% or breaches). */
  pass_rate_pct: number;
  /** Median months to resolution over resolved challenges. */
  median_months: number;
}

/**
 * E2.24.d.v — run-until-target FTMO simulation. FTMO Phase 1 has NO time
 * limit: a challenge runs until it hits the profit target (+`profitPct`),
 * the static Max Loss floor (−`mlPct`), or a daily-loss breach (−`dlPct`).
 * The fixed-60d-window pass rate (`stressTest`) is the WRONG metric —
 * most 60d windows end unresolved. This walks each historical start point
 * to resolution and reports P(pass) + median months, using the same
 * de-compounded, floating-inclusive machinery as `stressTest`.
 */
export function runUntilTarget(
  allTrades: BacktestTrade[],
  capital = POOL_CAPITAL,
  profitPct = 10,
  mlPct = 10,
  dlPct = 5
): ChallengeResult {
  const r: ChallengeResult = { starts: 0, resolved: 0, passes: 0, fails_ml: 0, fails_dl: 0, unresolved: 0, pass_rate_pct: 0, median_months: 0 };
  if (allTrades.length === 0) return r;
  const prepared: StressTrade[] = allTrades.map((t) => {
    const eq = t.equity_at_entry != null && t.equity_at_entry > 0 ? t.equity_at_entry : capital;
    return { entryDayMs: dayFloor(Date.parse(t.entry_date)), exitDayMs: dayFloor(Date.parse(t.exit_date)), pnlRet: t.pnl / eq, maeRet: (t.mae ?? 0) / eq };
  });
  const firstMs = dayFloor(Math.min(...prepared.map((t) => t.entryDayMs)));
  const lastMs = dayFloor(Math.max(...prepared.map((t) => t.exitDayMs)));
  const dayMs = 86_400_000;
  const durationsDays: number[] = [];

  for (let startMs = firstMs; startMs <= lastMs; startMs += STEP_DAYS * dayMs) {
    r.starts++;
    const active = prepared.filter((t) => t.entryDayMs >= startMs);
    const byExitDay = new Map<number, number>();
    for (const t of active) byExitDay.set(t.exitDayMs, (byExitDay.get(t.exitDayMs) ?? 0) + t.pnlRet);
    let realized = 0, prevFloatEq = capital, resolvedDay = -1;
    let outcome: "pass" | "ml" | "dl" | null = null;
    for (let d = startMs; d <= lastMs; d += dayMs) {
      realized += byExitDay.get(d) ?? 0;
      let openMaeRet = 0;
      for (const t of active) if (t.entryDayMs <= d && t.exitDayMs > d) openMaeRet += t.maeRet;
      const realizedEq = capital + realized * capital;
      const floatEq = realizedEq - openMaeRet * capital;
      const drop = prevFloatEq - floatEq;
      prevFloatEq = floatEq;
      if (floatEq <= capital * (1 - mlPct / 100)) { outcome = "ml"; resolvedDay = d; break; }
      if (drop > capital * (dlPct / 100)) { outcome = "dl"; resolvedDay = d; break; }
      if (realizedEq >= capital * (1 + profitPct / 100)) { outcome = "pass"; resolvedDay = d; break; }
    }
    if (outcome === null) { r.unresolved++; continue; }
    r.resolved++;
    durationsDays.push((resolvedDay - startMs) / dayMs);
    if (outcome === "pass") r.passes++;
    else if (outcome === "ml") r.fails_ml++;
    else r.fails_dl++;
  }
  r.pass_rate_pct = r.resolved ? (100 * r.passes) / r.resolved : 0;
  if (durationsDays.length) {
    const sorted = [...durationsDays].sort((a, b) => a - b);
    r.median_months = sorted[Math.floor(sorted.length / 2)] / 30.44;
  }
  return r;
}

/**
 * E2.25.b — convert start-stamped OANDA session daily bars (the pinned D
 * file: each bar OPENS at its stamp = 17:00 NY, CLOSES ~24h later) into
 * CLOSE-INSTANT-stamped bars so `alignCompletedDailyIndex` stays leak-free
 * while matching the live NY-session boundary. A session's close instant =
 * the next session's open stamp; the final bar closes ~24h after its open.
 * Re-stamping to the close (not the open) is what prevents a same-session
 * look-ahead — a bar keyed by its close day is complete only for intraday
 * decisions dated after it.
 */
export function sessionDailyClose(startStamped: PriceBar[]): PriceBar[] {
  const out: PriceBar[] = [];
  for (let i = 0; i < startStamped.length; i++) {
    const closeMs =
      i + 1 < startStamped.length
        ? Date.parse(startStamped[i + 1].date)
        : Date.parse(startStamped[i].date) + 86_400_000;
    out.push({ ...startStamped[i], date: new Date(closeMs).toISOString() });
  }
  return out;
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
