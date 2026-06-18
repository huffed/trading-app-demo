/**
 * STEP 3 (correct methodology per roadmap-2026-06).
 *
 * 3a — for each STEP-2 survivor, test SAME config with regime_filter=on
 *      single-variable change. If positive, apply.
 * 3b — walk-forward post-3a config on 12-month-train / 3-month-test
 *      rolling windows. Gate: ≥70% test windows green AND ≥70% per-year
 *      green.
 *
 * Methodology note: with no re-optimisation (we're testing the deployed
 * config), the "train" window is just minimum-history before the first
 * test window. Test windows are 3 months, rolling forward 3 months at a
 * time. Each test counts once (no overlap).
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

const TRAIN_MONTHS = 12;
const TEST_MONTHS = 3;

const STEP2_SURVIVORS = [
  "Library: Gold FVG-DailyBias-Long 4h",
  "Library: Gold FVG-Long 30m",
  "Library: Gold Coil-Breakout 4h",
  "Library: Gold Dip-Buyer 4h",
  "Library: Gold sweep_reclaim-DailyBias-Long 4h",
  "Library: USD/JPY FVG-DailyBias-Long 4h",
  "Library: USD/JPY sweep_reclaim-DailyBias-Long 4h",
];

function pnlOf(trades: BacktestTrade[]): number {
  return trades.reduce((s, t) => s + t.pnl, 0);
}

function tradesInWindow(trades: BacktestTrade[], start: Date, end: Date): BacktestTrade[] {
  return trades.filter((t) => {
    const exit = new Date(t.exit_date);
    return exit >= start && exit < end;
  });
}

function setRegimeFilter(rules: AlgorithmRules, enabled: boolean): AlgorithmRules {
  const r = JSON.parse(JSON.stringify(rules)) as AlgorithmRules;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ra = r as any;
  ra.regime_filter = { ...(ra.regime_filter ?? {}), enabled };
  return r;
}

interface Stats3a {
  off_total: number;
  off_wr: number;
  off_trades: number;
  on_total: number;
  on_wr: number;
  on_trades: number;
  apply_on: boolean;
}

interface AlgoVerdict {
  name: string;
  ticker: string;
  stats3a: Stats3a;
  total: number;
  totalTrades: number;
  wr: number;
  testWindows: { start: string; trades: number; pnl: number; green: boolean }[];
  testGreenPct: number;
  yearsGreenPct: number;
  verdict: "PASS" | "WEAK" | "FAIL";
  reason: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function analyze(supabase: any, name: string): Promise<AlgoVerdict | null> {
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

  // ----- 3a: regime_filter off vs on -----
  const offRules = setRegimeFilter(algo.rules, false);
  const onRules = setRegimeFilter(algo.rules, true);
  const offResult = runPortfolioBacktest(offRules, new Map([[ticker, bars]]), algo.capital, []);
  const onResult = runPortfolioBacktest(onRules, new Map([[ticker, bars]]), algo.capital, []);
  const off_total = pnlOf(offResult.trades);
  const on_total = pnlOf(onResult.trades);
  const off_wr = offResult.trades.length > 0 ? offResult.trades.filter((t) => t.pnl > 0).length / offResult.trades.length * 100 : 0;
  const on_wr = onResult.trades.length > 0 ? onResult.trades.filter((t) => t.pnl > 0).length / onResult.trades.length * 100 : 0;
  // Apply regime_filter=on if it materially improves total (+5% lift) AND WR doesn't drop below 37
  const apply_on = on_total > off_total * 1.05 && on_wr >= 37;
  const stats3a: Stats3a = { off_total, off_wr, off_trades: offResult.trades.length, on_total, on_wr, on_trades: onResult.trades.length, apply_on };

  // ----- 3b: walk-forward with chosen rules -----
  const chosenRules = apply_on ? onRules : offRules;
  const chosenResult = runPortfolioBacktest(chosenRules, new Map([[ticker, bars]]), algo.capital, []);
  const trades = chosenResult.trades;
  if (trades.length === 0) return null;
  const total = pnlOf(trades);
  const wr = Math.round(trades.filter((t) => t.pnl > 0).length / trades.length * 1000) / 10;

  // Test windows: 3-month, rolling 3 months, starting at first_trade + TRAIN_MONTHS
  const firstDate = new Date(trades[0].entry_date);
  const lastDate = new Date(trades[trades.length - 1].exit_date);
  const testStart = new Date(firstDate);
  testStart.setMonth(testStart.getMonth() + TRAIN_MONTHS);
  const testWindows: { start: string; trades: number; pnl: number; green: boolean }[] = [];
  let cursor = new Date(testStart);
  while (cursor < lastDate) {
    const end = new Date(cursor);
    end.setMonth(end.getMonth() + TEST_MONTHS);
    const wt = tradesInWindow(trades, cursor, end);
    if (wt.length > 0) {
      const wp = pnlOf(wt);
      testWindows.push({ start: cursor.toISOString().slice(0, 7), trades: wt.length, pnl: Math.round(wp * 100) / 100, green: wp > 0 });
    }
    cursor = new Date(end);
  }
  const testGreen = testWindows.filter((w) => w.green).length;
  const testGreenPct = testWindows.length === 0 ? 0 : Math.round(testGreen / testWindows.length * 100);

  // Per-year decomp
  const byYear = new Map<string, number>();
  for (const t of trades) {
    const y = t.exit_date.slice(0, 4);
    byYear.set(y, (byYear.get(y) ?? 0) + t.pnl);
  }
  const years = [...byYear.entries()].sort();
  const yearsGreen = years.filter(([, p]) => p > 0).length;
  const yearsGreenPct = years.length === 0 ? 0 : Math.round(yearsGreen / years.length * 100);

  let verdict: AlgoVerdict["verdict"] = "FAIL";
  let reason = "";
  if (total <= 0) { verdict = "FAIL"; reason = "aggregate negative"; }
  else if (testGreenPct >= 70 && yearsGreenPct >= 70) { verdict = "PASS"; reason = "both gates pass"; }
  else if (testGreenPct >= 50 && yearsGreenPct >= 50) { verdict = "WEAK"; reason = `WF ${testGreenPct}% / per-year ${yearsGreenPct}%`; }
  else { verdict = "FAIL"; reason = `WF ${testGreenPct}% / per-year ${yearsGreenPct}% — both below 50`; }

  return { name, ticker, stats3a, total: Math.round(total * 100) / 100, totalTrades: trades.length, wr, testWindows, testGreenPct, yearsGreenPct, verdict, reason };
}

async function main(): Promise<void> {
  console.log(`\n===== STEP 3 (correct) — 3a regime + 3b ${TRAIN_MONTHS}mo-train/${TEST_MONTHS}mo-test @ ${new Date().toISOString().slice(0, 16)} =====\n`);
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const supabase = createClient(url, key, { auth: { persistSession: false } });

  const verdicts: AlgoVerdict[] = [];
  for (const name of STEP2_SURVIVORS) {
    const v = await analyze(supabase, name);
    if (!v) { console.log(`  ${name}: SKIP`); continue; }
    verdicts.push(v);
    const r = v.stats3a;
    console.log(`\n--- ${v.name} (${v.ticker}) ---`);
    console.log(`  3a: regime_filter OFF $${r.off_total.toFixed(0)}/${r.off_trades}t/WR${r.off_wr.toFixed(0)}% | ON $${r.on_total.toFixed(0)}/${r.on_trades}t/WR${r.on_wr.toFixed(0)}% | APPLY ${r.apply_on ? "ON" : "OFF"}`);
    console.log(`  3b: $${v.total} / ${v.totalTrades}t / WR ${v.wr}% | ${v.testWindows.length} test windows`);
    for (const w of v.testWindows) console.log(`     ${w.start} (${w.trades}t): $${w.pnl} ${w.green ? "✓" : "✗"}`);
    console.log(`  Test green: ${v.testGreenPct}% | Years green: ${v.yearsGreenPct}%`);
    console.log(`  VERDICT: ${v.verdict} — ${v.reason}`);
  }

  console.log(`\n${"=".repeat(120)}`);
  console.log(`STEP 3 SUMMARY (12mo-train / 3mo-test rolling)`);
  console.log(`${"=".repeat(120)}`);
  for (const v of verdicts) {
    console.log(`  ${v.verdict.padEnd(6)} ${v.name.padEnd(50)} test ${v.testGreenPct}% / per-year ${v.yearsGreenPct}% — $${v.total} ${v.stats3a.apply_on ? "(regime_filter=on)" : ""}`);
  }
  const pass = verdicts.filter((v) => v.verdict === "PASS").length;
  const weak = verdicts.filter((v) => v.verdict === "WEAK").length;
  const fail = verdicts.filter((v) => v.verdict === "FAIL").length;
  console.log(`\n  ${pass} PASS / ${weak} WEAK / ${fail} FAIL\n`);
}

void main();
