/**
 * STEP 3 — Walk-forward filter on STEP-2 survivors (per roadmap-2026-06).
 *
 * Runs 6-month rolling-window decomposition on each STEP-2-passing algo
 * using its DEPLOYED rules (now with realistic friction 3/0/0 from STEP 2).
 *
 * Gate per CLAUDE.md 4-way framework: ≥70% windows green to pass STEP 3.
 *
 * Also reports per-year decomp because it catches regime-concentration
 * that aggregate stats hide (the FVG-DailyBias 2021-chop-rescue pattern).
 *
 * Output: per-algo verdict
 *   - PASS: ≥70% windows green AND ≥70% years green
 *   - WEAK: marginal (one of those two below threshold)
 *   - FAIL: both below threshold or aggregate negative under windows
 */
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import { timeframeToInterval } from "../src/lib/market-data/interval";
import { runPortfolioBacktest } from "../src/lib/market-data/portfolio-backtest";
import type { BacktestTrade, PriceBar } from "../src/lib/market-data/types";
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getBarsNoTtl(supabase: any, ticker: string, interval: string): Promise<PriceBar[] | null> {
  const { data } = await supabase
    .from("price_cache")
    .select("bars")
    .eq("ticker", ticker.toUpperCase())
    .eq("output_size", "full")
    .eq("interval", interval)
    .limit(1)
    .single();
  return (data as { bars: PriceBar[] } | null)?.bars ?? null;
}

const WINDOW_MONTHS = 6;

const STEP2_SURVIVORS = [
  "Library: Gold FVG-DailyBias-Long 4h",
  "Library: Gold FVG-Long 30m",
  "Library: Gold Coil-Breakout 4h",
  "Library: Gold Dip-Buyer 4h",
  "Library: Gold sweep_reclaim-DailyBias-Long 4h",
  "Library: USD/JPY FVG-DailyBias-Long 4h",
  "Library: USD/JPY sweep_reclaim-DailyBias-Long 4h",
];

interface WindowResult {
  start: string;
  end: string;
  trades: number;
  pnl: number;
  green: boolean;
}

interface YearResult {
  year: string;
  trades: number;
  pnl: number;
  wr: number;
  green: boolean;
}

interface AlgoResult {
  name: string;
  ticker: string;
  capital: number;
  total: number;
  totalTrades: number;
  totalWr: number;
  windows: WindowResult[];
  windowsGreen: number;
  windowsGreenPct: number;
  years: YearResult[];
  yearsGreen: number;
  yearsGreenPct: number;
  verdict: "PASS" | "WEAK" | "FAIL";
  reason: string;
}

function tradesInWindow(trades: BacktestTrade[], start: Date, end: Date): BacktestTrade[] {
  return trades.filter((t) => {
    const exit = new Date(t.exit_date);
    return exit >= start && exit < end;
  });
}

function pnlOf(trades: BacktestTrade[]): number {
  return trades.reduce((s, t) => s + t.pnl, 0);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function analyzeAlgo(supabase: any, name: string): Promise<AlgoResult | null> {
  const algoRes = await supabase.from("algorithms").select("id, capital, rules").eq("name", name).single();
  if (algoRes.error || !algoRes.data) return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const algo = algoRes.data as any as { id: string; capital: number; rules: AlgorithmRules };
  const wl = await supabase.from("algorithm_watchlist").select("ticker").eq("algorithm_id", algo.id);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ticker = ((wl.data ?? []) as any[])[0]?.ticker?.toUpperCase() ?? "";
  const interval = timeframeToInterval(algo.rules.timeframe);
  const bars = await getBarsNoTtl(supabase, ticker, interval);
  if (!bars) return null;
  const result = runPortfolioBacktest(algo.rules, new Map([[ticker, bars]]), algo.capital, []);
  const trades = result.trades;
  if (trades.length === 0) return null;

  const total = pnlOf(trades);
  const wins = trades.filter((t) => t.pnl > 0).length;
  const totalWr = Math.round(wins / trades.length * 1000) / 10;

  // Walk-forward
  const firstDate = new Date(trades[0].entry_date);
  const lastDate = new Date(trades[trades.length - 1].exit_date);
  const windows: WindowResult[] = [];
  let cursor = new Date(firstDate);
  while (cursor < lastDate) {
    const end = new Date(cursor);
    end.setMonth(end.getMonth() + WINDOW_MONTHS);
    const wt = tradesInWindow(trades, cursor, end);
    if (wt.length > 0) {
      const wp = pnlOf(wt);
      windows.push({
        start: cursor.toISOString().slice(0, 7),
        end: end.toISOString().slice(0, 7),
        trades: wt.length,
        pnl: Math.round(wp * 100) / 100,
        green: wp > 0,
      });
    }
    cursor = new Date(end);
  }
  const windowsGreen = windows.filter((w) => w.green).length;
  const windowsGreenPct = windows.length === 0 ? 0 : Math.round(windowsGreen / windows.length * 100);

  // Per-year
  const byYear = new Map<string, BacktestTrade[]>();
  for (const t of trades) {
    const y = t.exit_date.slice(0, 4);
    const arr = byYear.get(y) ?? [];
    arr.push(t);
    byYear.set(y, arr);
  }
  const years: YearResult[] = [];
  for (const y of [...byYear.keys()].sort()) {
    const ts = byYear.get(y)!;
    const wp = pnlOf(ts);
    const wn = ts.filter((t) => t.pnl > 0).length;
    years.push({
      year: y,
      trades: ts.length,
      pnl: Math.round(wp * 100) / 100,
      wr: Math.round(wn / ts.length * 1000) / 10,
      green: wp > 0,
    });
  }
  const yearsGreen = years.filter((y) => y.green).length;
  const yearsGreenPct = years.length === 0 ? 0 : Math.round(yearsGreen / years.length * 100);

  let verdict: AlgoResult["verdict"] = "FAIL";
  let reason = "";
  if (total <= 0) {
    verdict = "FAIL";
    reason = "aggregate negative";
  } else if (windowsGreenPct >= 70 && yearsGreenPct >= 70) {
    verdict = "PASS";
    reason = "both gates pass";
  } else if (windowsGreenPct >= 50 && yearsGreenPct >= 50) {
    verdict = "WEAK";
    reason = `WF ${windowsGreenPct}% / per-year ${yearsGreenPct}% — marginal`;
  } else {
    verdict = "FAIL";
    reason = `WF ${windowsGreenPct}% green AND per-year ${yearsGreenPct}% green — both below 50`;
  }

  return {
    name, ticker, capital: algo.capital, total: Math.round(total * 100) / 100,
    totalTrades: trades.length, totalWr,
    windows, windowsGreen, windowsGreenPct,
    years, yearsGreen, yearsGreenPct,
    verdict, reason,
  };
}

async function main(): Promise<void> {
  console.log(`\n===== STEP 3 walk-forward @ ${new Date().toISOString().slice(0, 16)} =====`);
  console.log(`Window: ${WINDOW_MONTHS}-month rolling. Gate: ≥70% windows green AND ≥70% years green.\n`);
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const supabase = createClient(url, key, { auth: { persistSession: false } });

  const results: AlgoResult[] = [];
  for (const name of STEP2_SURVIVORS) {
    const r = await analyzeAlgo(supabase, name);
    if (!r) { console.log(`  ${name}: SKIP (no data)`); continue; }
    results.push(r);
    console.log(`\n--- ${r.name} (${r.ticker}, cap=$${r.capital}) ---`);
    console.log(`  Total: $${r.total} / ${r.totalTrades}t / WR ${r.totalWr}%`);
    console.log(`  WALK-FORWARD (${r.windows.length} windows, ${r.windowsGreen} green = ${r.windowsGreenPct}%):`);
    for (const w of r.windows) {
      console.log(`    ${w.start} (${w.trades}t): $${w.pnl} ${w.green ? "✓" : "✗"}`);
    }
    console.log(`  PER YEAR (${r.years.length} years, ${r.yearsGreen} green = ${r.yearsGreenPct}%):`);
    for (const y of r.years) {
      console.log(`    ${y.year} (${y.trades}t WR ${y.wr}%): $${y.pnl} ${y.green ? "✓" : "✗"}`);
    }
    console.log(`  VERDICT: ${r.verdict} — ${r.reason}`);
  }

  console.log(`\n${"=".repeat(120)}`);
  console.log(`STEP 3 SUMMARY`);
  console.log(`${"=".repeat(120)}`);
  for (const r of results) {
    console.log(`  ${r.verdict.padEnd(6)} ${r.name.padEnd(50)} WF ${r.windowsGreenPct}% / per-year ${r.yearsGreenPct}% — $${r.total}`);
  }
  const pass = results.filter((r) => r.verdict === "PASS").length;
  const weak = results.filter((r) => r.verdict === "WEAK").length;
  const fail = results.filter((r) => r.verdict === "FAIL").length;
  console.log(`\n  ${pass} PASS / ${weak} WEAK / ${fail} FAIL\n`);
}

void main();
