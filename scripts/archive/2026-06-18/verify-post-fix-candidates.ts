/**
 * Comprehensive verification of post-fix candidates (2026-06-18):
 *   1. Active-survivor config tweaks (FVG-DailyBias lb=3 → lb=4)
 *   2. Paused-algo unpause candidates (sweep_reclaim, Dip-Buyer, Coil-Breakout 1h)
 *
 * For each candidate, runs:
 *   A. Full stats inc. **DAILY DD** (operator's locked rule's missing piece)
 *   B. Per-year decomp (regime-concentration check)
 *   C. Plateau check — ±1 grid step around winner (noise-peak filter)
 *   D. Friction overlay — re-run with realistic slippage/spread (4-way framework)
 *
 * Plus walk-forward (6-mo rolling windows) for Coil-Breakout 1h, the
 * biggest unpause decision.
 */
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import { timeframeToInterval } from "../src/lib/market-data/interval";
import { runPortfolioBacktest } from "../src/lib/market-data/portfolio-backtest";
import { getCachedPrices } from "../src/lib/market-data/price-cache";
import type { BacktestTrade } from "../src/lib/market-data/types";
import type { AlgorithmRules } from "../src/types/algorithm";

{
  try {
    const raw = readFileSync(".env.local", "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (!m) continue;
      const [, k, v] = m;
      if (!process.env[k]) process.env[k] = v.replace(/^['"]|['"]$/g, "");
    }
  } catch {}
}

const RR_STEPS = [1.5, 2, 2.5, 3, 4, 5];
const LB_STEPS = [3, 4, 5, 6, 8, 12];
const WINDOW_MONTHS = 6;
const FRICTION_SLIPPAGE_BPS = 0.5;  // gold 4-way framework default
const FRICTION_SPREAD_BPS = 0.4;

const CANDIDATES = [
  { name: "Library: Gold FVG-DailyBias-Long 4h", rr: 2.5, lb: 4, note: "active — proposed lb=3 → lb=4" },
  { name: "Library: Gold sweep_reclaim-DailyBias-Long 4h", rr: 3, lb: 5, note: "paused — propose unpause RR=3 lb=5" },
  { name: "Library: Gold Dip-Buyer 4h", rr: 2.5, lb: 12, note: "paused — propose unpause RR=2.5 lb=12" },
  { name: "Library: Gold Coil-Breakout 1h", rr: 4, lb: 12, note: "paused — propose unpause RR=4 lb=12 (BIG ONE)", walkForward: true },
];

interface CellStats {
  trades: number;
  total: number;
  sdd: number;
  pdd: number;
  ddd: number;
  wr: number;
}

function cloneWith(rules: AlgorithmRules, rr: number, lb: number, friction = false): AlgorithmRules {
  const r = JSON.parse(JSON.stringify(rules)) as AlgorithmRules;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (r as any).take_profit.value = rr;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (r as any).stop_loss.lookback = lb;
  if (friction) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pf = (r as any).prop_firm ?? {};
    pf.slippage_bps = FRICTION_SLIPPAGE_BPS;
    pf.spread_bps = FRICTION_SPREAD_BPS;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (r as any).prop_firm = pf;
  }
  return r;
}

function computeStats(trades: BacktestTrade[], capital: number): CellStats {
  if (trades.length === 0) return { trades: 0, total: 0, sdd: 0, pdd: 0, ddd: 0, wr: 0 };
  const sorted = [...trades].sort((a, b) => new Date(a.exit_date).getTime() - new Date(b.exit_date).getTime());
  let cum = 0, peak = 0, maxPdd = 0, maxSdd = 0, wins = 0;
  // Daily DD: sum of pnl per exit_date, find worst single-day net loss
  const dailyPnl = new Map<string, number>();
  for (const t of sorted) {
    cum += t.pnl;
    if (t.pnl > 0) wins++;
    if (cum > peak) peak = cum;
    const pdd = ((peak - cum) / capital) * 100;
    if (pdd > maxPdd) maxPdd = pdd;
    const sdd = cum < 0 ? (-cum / capital) * 100 : 0;
    if (sdd > maxSdd) maxSdd = sdd;
    const day = t.exit_date.slice(0, 10);
    dailyPnl.set(day, (dailyPnl.get(day) ?? 0) + t.pnl);
  }
  let worstDay = 0;
  for (const v of dailyPnl.values()) if (v < worstDay) worstDay = v;
  const ddd = worstDay < 0 ? ((-worstDay) / capital) * 100 : 0;
  return {
    trades: sorted.length,
    total: Math.round(cum * 100) / 100,
    sdd: Math.round(maxSdd * 100) / 100,
    pdd: Math.round(maxPdd * 100) / 100,
    ddd: Math.round(ddd * 100) / 100,
    wr: Math.round(wins / sorted.length * 1000) / 10,
  };
}

function pnlByYear(trades: BacktestTrade[]): Map<string, { total: number; trades: number; wins: number }> {
  const out = new Map<string, { total: number; trades: number; wins: number }>();
  for (const t of trades) {
    const y = t.exit_date.slice(0, 4);
    const r = out.get(y) ?? { total: 0, trades: 0, wins: 0 };
    r.total += t.pnl;
    r.trades++;
    if (t.pnl > 0) r.wins++;
    out.set(y, r);
  }
  return out;
}

function neighbours(rr: number, lb: number): { rr: number; lb: number }[] {
  const rrIdx = RR_STEPS.indexOf(rr);
  const lbIdx = LB_STEPS.indexOf(lb);
  const out: { rr: number; lb: number }[] = [];
  for (const dr of [-1, 0, 1]) {
    for (const dl of [-1, 0, 1]) {
      if (dr === 0 && dl === 0) continue;
      const newR = RR_STEPS[rrIdx + dr];
      const newL = LB_STEPS[lbIdx + dl];
      if (newR != null && newL != null) out.push({ rr: newR, lb: newL });
    }
  }
  return out;
}

function tradesInWindow(trades: BacktestTrade[], start: Date, end: Date): BacktestTrade[] {
  return trades.filter((t) => {
    const exit = new Date(t.exit_date);
    return exit >= start && exit < end;
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function verify(supabase: any, c: typeof CANDIDATES[0]): Promise<void> {
  const algoRes = await supabase.from("algorithms").select("id, capital, rules").eq("name", c.name).single();
  if (algoRes.error || !algoRes.data) { console.log(`\n  ${c.name}: not in DB`); return; }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const algo = algoRes.data as any as { id: string; capital: number; rules: AlgorithmRules };
  const wl = await supabase.from("algorithm_watchlist").select("ticker").eq("algorithm_id", algo.id);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ticker = ((wl.data ?? []) as any[])[0]?.ticker?.toUpperCase() ?? "";
  const interval = timeframeToInterval(algo.rules.timeframe);
  const bars = await getCachedPrices(ticker, "full", interval);
  if (!bars) { console.log(`\n  ${c.name}: no bars for ${ticker}`); return; }

  console.log(`\n\n===== ${c.name} =====`);
  console.log(`  ${c.note}`);
  console.log(`  ${ticker} ${interval} (${bars.length} bars, cap=${algo.capital})`);

  // ----- A: Full stats incl daily DD (frictionless) -----
  const frictionlessRules = cloneWith(algo.rules, c.rr, c.lb, false);
  const frictionless = runPortfolioBacktest(frictionlessRules, new Map([[ticker, bars]]), algo.capital, []);
  const sFrictionless = computeStats(frictionless.trades, algo.capital);
  console.log(`\n  A. STATS (frictionless) RR=${c.rr} lb=${c.lb}:`);
  console.log(`     $${sFrictionless.total} / ${sFrictionless.trades}t / WR ${sFrictionless.wr}%`);
  console.log(`     STATIC DD ${sFrictionless.sdd}% (FTMO ≤10%)  |  DAILY DD ${sFrictionless.ddd}% (FTMO ≤5%)  |  peak-trough ${sFrictionless.pdd}%`);
  const ftmoSafe = sFrictionless.sdd < 10 && sFrictionless.ddd < 5 && sFrictionless.wr >= 37 && sFrictionless.total > 0;
  console.log(`     FTMO + 37% WR pass: ${ftmoSafe ? "✓ PASS" : "✗ FAIL"}`);

  // ----- B: Per-year decomp -----
  console.log(`\n  B. PER-YEAR DECOMP:`);
  const years = pnlByYear(frictionless.trades);
  const yearsSorted = [...years.keys()].sort();
  for (const y of yearsSorted) {
    const r = years.get(y)!;
    const yWr = r.trades > 0 ? Math.round(r.wins / r.trades * 1000) / 10 : 0;
    console.log(`     ${y}: $${r.total.toFixed(0)} (${r.trades}t, WR ${yWr}%)  ${r.total >= 0 ? "✓" : "✗"}`);
  }
  const greenYears = yearsSorted.filter((y) => years.get(y)!.total > 0).length;
  console.log(`     SUMMARY: ${greenYears}/${yearsSorted.length} years green (${Math.round(greenYears/yearsSorted.length*100)}%)`);

  // ----- C: Plateau check -----
  console.log(`\n  C. PLATEAU CHECK (±1 grid step):`);
  const nb = neighbours(c.rr, c.lb);
  let worseCount = 0, betterCount = 0, similarCount = 0;
  for (const n of nb) {
    const result = runPortfolioBacktest(cloneWith(algo.rules, n.rr, n.lb, false), new Map([[ticker, bars]]), algo.capital, []);
    const s = computeStats(result.trades, algo.capital);
    const diffPct = sFrictionless.total === 0 ? 0 : ((s.total - sFrictionless.total) / Math.abs(sFrictionless.total)) * 100;
    const tag = s.total < sFrictionless.total * 0.5 ? "WORSE" : s.total > sFrictionless.total * 1.2 ? "BETTER" : "OK";
    if (tag === "WORSE") worseCount++;
    else if (tag === "BETTER") betterCount++;
    else similarCount++;
    console.log(`     RR=${n.rr} lb=${n.lb}: $${s.total.toFixed(0)} (${diffPct >= 0 ? "+" : ""}${diffPct.toFixed(0)}%) DD${s.sdd}% WR${s.wr}%  [${tag}]`);
  }
  const plateau = worseCount <= nb.length / 2 && betterCount === 0;
  console.log(`     SUMMARY: ${worseCount}/${nb.length} worse, ${similarCount}/${nb.length} similar, ${betterCount}/${nb.length} better. Plateau: ${plateau ? "✓" : "✗"}`);

  // ----- D: Friction overlay -----
  console.log(`\n  D. FRICTION OVERLAY (slippage=${FRICTION_SLIPPAGE_BPS}bps, spread=${FRICTION_SPREAD_BPS}bps):`);
  const frictionRules = cloneWith(algo.rules, c.rr, c.lb, true);
  const friction = runPortfolioBacktest(frictionRules, new Map([[ticker, bars]]), algo.capital, []);
  const sFriction = computeStats(friction.trades, algo.capital);
  const fricDiffPct = sFrictionless.total === 0 ? 0 : ((sFriction.total - sFrictionless.total) / Math.abs(sFrictionless.total)) * 100;
  console.log(`     $${sFriction.total} / ${sFriction.trades}t / WR ${sFriction.wr}%`);
  console.log(`     STATIC DD ${sFriction.sdd}%  |  DAILY DD ${sFriction.ddd}%  |  peak-trough ${sFriction.pdd}%`);
  console.log(`     Return vs frictionless: ${fricDiffPct >= 0 ? "+" : ""}${fricDiffPct.toFixed(1)}%`);
  const frictionFtmoSafe = sFriction.sdd < 10 && sFriction.ddd < 5 && sFriction.wr >= 37 && sFriction.total > 0;
  console.log(`     FTMO + 37% WR pass under friction: ${frictionFtmoSafe ? "✓ PASS" : "✗ FAIL"}`);

  // ----- E: Walk-forward (only for marked candidates) -----
  if (c.walkForward) {
    console.log(`\n  E. WALK-FORWARD (${WINDOW_MONTHS}-month rolling):`);
    const firstDate = new Date(bars[0].date);
    const lastDate = new Date(bars[bars.length - 1].date);
    const windows: { start: Date; end: Date }[] = [];
    let cursor = new Date(firstDate);
    while (cursor < lastDate) {
      const end = new Date(cursor);
      end.setMonth(end.getMonth() + WINDOW_MONTHS);
      windows.push({ start: new Date(cursor), end });
      cursor = end;
    }
    let greenCount = 0, totalCount = 0;
    for (const w of windows) {
      const wt = tradesInWindow(frictionless.trades, w.start, w.end);
      if (wt.length === 0) continue;
      totalCount++;
      const wp = wt.reduce((s, t) => s + t.pnl, 0);
      if (wp > 0) greenCount++;
      console.log(`     ${w.start.toISOString().slice(0, 7)} (${wt.length}t): $${wp.toFixed(0)} ${wp >= 0 ? "✓" : "✗"}`);
    }
    const wfPct = Math.round(greenCount / totalCount * 100);
    console.log(`     SUMMARY: ${greenCount}/${totalCount} windows green (${wfPct}%). Threshold ≥70%: ${wfPct >= 70 ? "✓" : "✗"}`);
  }

  // ----- VERDICT -----
  console.log(`\n  VERDICT:`);
  console.log(`     FTMO-safe (frictionless): ${ftmoSafe ? "✓" : "✗"}`);
  console.log(`     FTMO-safe (with friction): ${frictionFtmoSafe ? "✓" : "✗"}`);
  console.log(`     Per-year ≥70% green: ${greenYears/yearsSorted.length >= 0.7 ? "✓" : "✗"}`);
  console.log(`     Plateau: ${plateau ? "✓" : "✗"}`);
  const overall = ftmoSafe && frictionFtmoSafe && greenYears/yearsSorted.length >= 0.7 && plateau;
  console.log(`     OVERALL: ${overall ? "✅ APPLY/UNPAUSE" : "⚠ NEEDS REVIEW"}`);
}

async function main(): Promise<void> {
  console.log(`\n===== Post-fix candidate verification @ ${new Date().toISOString().slice(0, 16)} =====`);
  console.log(`(After fvg + liquidity_sweep bug fixes 2026-06-18)\n`);
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const supabase = createClient(url, key, { auth: { persistSession: false } });
  for (const c of CANDIDATES) await verify(supabase, c);
}

void main();
