/**
 * Three-test validation of the 3 proposed config changes:
 *   1. Walk-forward — 6-month rolling windows. % of windows green
 *      = robustness check. If ≥80% windows positive, the config
 *      isn't regime-specific.
 *   2. Per-year decomp — cumulative pnl per year. Catches
 *      "+$10K in 2020-2021, -$3K every year since" cases that
 *      aggregate stats hide.
 *   3. Plateau check — test ±1 grid step in each direction. If
 *      proposed cell is dramatically better than neighbours, it's
 *      probably a noise peak. Plateau means neighbours are similar.
 *
 * Outputs a verdict per algo: ROBUST / FRAGILE / MIXED.
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

const PROPOSED = [
  { algo: "Library: Gold FVG-Long 30m", rr: 3, lb: 6, current: { rr: 2, lb: 12 } },
  { algo: "Library: Gold Coil-Breakout 4h", rr: 2.5, lb: 3, current: { rr: 2, lb: 8 } },
  { algo: "Library: Gold Coil-Breakout 1h", rr: 4, lb: 12, current: { rr: 4, lb: 6 } },
];

function cloneWith(rules: AlgorithmRules, rr: number, lb: number): AlgorithmRules {
  const r = JSON.parse(JSON.stringify(rules)) as AlgorithmRules;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (r as any).take_profit.value = rr;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (r as any).stop_loss.lookback = lb;
  return r;
}

function tradesInWindow(trades: BacktestTrade[], start: Date, end: Date): BacktestTrade[] {
  return trades.filter((t) => {
    const exit = new Date(t.exit_date);
    return exit >= start && exit < end;
  });
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

function pnl(trades: BacktestTrade[]): number {
  return trades.reduce((s, t) => s + t.pnl, 0);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function validate(supabase: any, p: typeof PROPOSED[0]): Promise<void> {
  const algoRes = await supabase.from("algorithms").select("id, capital, rules").eq("name", p.algo).single();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const algo = algoRes.data as any as { id: string; capital: number; rules: AlgorithmRules };
  const wl = await supabase.from("algorithm_watchlist").select("ticker").eq("algorithm_id", algo.id);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ticker = ((wl.data ?? []) as any[])[0]?.ticker?.toUpperCase() ?? "";
  const interval = timeframeToInterval(algo.rules.timeframe);
  const bars = await getCachedPrices(ticker, "full", interval);
  if (!bars) { console.log(`  ${p.algo}: no bars`); return; }

  console.log(`\n===== ${p.algo} =====`);
  console.log(`  Proposed: RR=${p.rr} lb=${p.lb}  vs  Current: RR=${p.current.rr} lb=${p.current.lb}`);

  // Run both configs on full corpus, capture trades
  const proposedResult = runPortfolioBacktest(cloneWith(algo.rules, p.rr, p.lb), new Map([[ticker, bars]]), algo.capital, []);
  const currentResult = runPortfolioBacktest(cloneWith(algo.rules, p.current.rr, p.current.lb), new Map([[ticker, bars]]), algo.capital, []);
  console.log(`  Full corpus: proposed $${pnl(proposedResult.trades).toFixed(0)} (${proposedResult.trades.length}t)  vs  current $${pnl(currentResult.trades).toFixed(0)} (${currentResult.trades.length}t)`);

  // ----- TEST 1: Walk-forward (6-month rolling windows) -----
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

  let propGreenWindows = 0, currGreenWindows = 0, windowsWithTrades = 0;
  const windowSummary: string[] = [];
  for (const w of windows) {
    const propWin = tradesInWindow(proposedResult.trades, w.start, w.end);
    const currWin = tradesInWindow(currentResult.trades, w.start, w.end);
    if (propWin.length === 0 && currWin.length === 0) continue;
    windowsWithTrades++;
    const propPnl = pnl(propWin);
    const currPnl = pnl(currWin);
    if (propPnl > 0) propGreenWindows++;
    if (currPnl > 0) currGreenWindows++;
    windowSummary.push(`    ${w.start.toISOString().slice(0, 7)} (${propWin.length}t): proposed $${propPnl.toFixed(0)} ${propPnl >= 0 ? "✓" : "✗"} | current $${currPnl.toFixed(0)} ${currPnl >= 0 ? "✓" : "✗"}`);
  }
  console.log(`\n  WALK-FORWARD: ${WINDOW_MONTHS}-mo rolling windows (${windowsWithTrades} with trades):`);
  for (const s of windowSummary) console.log(s);
  console.log(`    SUMMARY:  proposed ${propGreenWindows}/${windowsWithTrades} green (${Math.round(propGreenWindows / windowsWithTrades * 100)}%)  |  current ${currGreenWindows}/${windowsWithTrades} green (${Math.round(currGreenWindows / windowsWithTrades * 100)}%)`);

  // ----- TEST 2: Per-year -----
  const byYear = new Map<string, { proposed: number; current: number; propT: number; currT: number }>();
  for (const t of proposedResult.trades) {
    const y = t.exit_date.slice(0, 4);
    const row = byYear.get(y) ?? { proposed: 0, current: 0, propT: 0, currT: 0 };
    row.proposed += t.pnl;
    row.propT++;
    byYear.set(y, row);
  }
  for (const t of currentResult.trades) {
    const y = t.exit_date.slice(0, 4);
    const row = byYear.get(y) ?? { proposed: 0, current: 0, propT: 0, currT: 0 };
    row.current += t.pnl;
    row.currT++;
    byYear.set(y, row);
  }
  console.log(`\n  PER YEAR:`);
  for (const y of [...byYear.keys()].sort()) {
    const r = byYear.get(y)!;
    console.log(`    ${y}: proposed $${r.proposed.toFixed(0)} (${r.propT}t) | current $${r.current.toFixed(0)} (${r.currT}t) | diff $${(r.proposed - r.current).toFixed(0)}`);
  }

  // ----- TEST 3: Plateau check -----
  const nb = neighbours(p.rr, p.lb);
  console.log(`\n  PLATEAU CHECK: ${nb.length} neighbours of (RR=${p.rr}, lb=${p.lb}):`);
  const propPnl = pnl(proposedResult.trades);
  let worseCount = 0, betterCount = 0;
  for (const n of nb) {
    const nResult = runPortfolioBacktest(cloneWith(algo.rules, n.rr, n.lb), new Map([[ticker, bars]]), algo.capital, []);
    const nPnl = pnl(nResult.trades);
    const diffPct = propPnl === 0 ? 0 : ((nPnl - propPnl) / Math.abs(propPnl)) * 100;
    console.log(`    RR=${n.rr} lb=${n.lb}: $${nPnl.toFixed(0)} (${diffPct >= 0 ? "+" : ""}${diffPct.toFixed(0)}% vs proposed)`);
    if (nPnl < propPnl * 0.5) worseCount++;
    if (nPnl > propPnl * 1.2) betterCount++;
  }

  // ----- VERDICT -----
  const wfGreenPct = (propGreenWindows / windowsWithTrades) * 100;
  const yearsGreen = [...byYear.values()].filter((r) => r.proposed > 0).length;
  const totalYears = byYear.size;
  let verdict = "MIXED";
  if (wfGreenPct >= 70 && yearsGreen / totalYears >= 0.7 && worseCount <= nb.length / 2 && betterCount === 0) verdict = "ROBUST";
  else if (wfGreenPct < 50 || yearsGreen / totalYears < 0.4 || betterCount >= 2) verdict = "FRAGILE";
  console.log(`\n  VERDICT: ${verdict}`);
  console.log(`    WF green: ${wfGreenPct.toFixed(0)}% | per-year green: ${yearsGreen}/${totalYears} | plateau worse: ${worseCount}/${nb.length} | plateau better: ${betterCount}/${nb.length}`);
}

async function main(): Promise<void> {
  console.log(`\n===== Validation of proposed changes @ ${new Date().toISOString().slice(0, 16)} =====`);
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const supabase = createClient(url, key, { auth: { persistSession: false } });
  for (const p of PROPOSED) await validate(supabase, p);
}

void main();
