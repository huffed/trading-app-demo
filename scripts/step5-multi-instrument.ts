/**
 * STEP 5 — Multi-instrument cross-check on gold-survivor configs.
 *
 * For each gold-survivor (post-STEP-3), test the SAME rules on USD/JPY /
 * GBP/USD / EUR/USD bars. Does any gold-tuned config show edge on forex?
 *
 * Same friction (3/0/0 from STEP 2). Same gate (positive + WR≥37 +
 * static DD<10 + daily DD<5).
 *
 * Output:
 *   - "forex configs found, queue for promotion" OR
 *   - "confirm forex needs new entry conditions (STEP 9)"
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

const GOLD_SURVIVORS = [
  "Library: Gold FVG-DailyBias-Long 4h",
  "Library: Gold FVG-Long 30m",
  "Library: Gold Coil-Breakout 4h",
  "Library: Gold Dip-Buyer 4h",
  "Library: Gold sweep_reclaim-DailyBias-Long 4h",
];

const FOREX_TICKERS = ["USD/JPY", "GBP/USD", "EUR/USD"];

interface Stats {
  total: number;
  trades: number;
  wr: number;
  sdd: number;
  ddd: number;
}

function computeStats(trades: BacktestTrade[], capital: number): Stats {
  if (trades.length === 0) return { total: 0, trades: 0, wr: 0, sdd: 0, ddd: 0 };
  const sorted = [...trades].sort((a, b) => new Date(a.exit_date).getTime() - new Date(b.exit_date).getTime());
  let cum = 0, maxSdd = 0, wins = 0;
  const dailyPnl = new Map<string, number>();
  for (const t of sorted) {
    cum += t.pnl;
    if (t.pnl > 0) wins++;
    const sdd = cum < 0 ? (-cum / capital) * 100 : 0;
    if (sdd > maxSdd) maxSdd = sdd;
    const day = t.exit_date.slice(0, 10);
    dailyPnl.set(day, (dailyPnl.get(day) ?? 0) + t.pnl);
  }
  let worstDay = 0;
  for (const v of dailyPnl.values()) if (v < worstDay) worstDay = v;
  const ddd = worstDay < 0 ? (-worstDay / capital) * 100 : 0;
  return {
    total: Math.round(cum * 100) / 100,
    trades: sorted.length,
    wr: Math.round(wins / sorted.length * 1000) / 10,
    sdd: Math.round(maxSdd * 100) / 100,
    ddd: Math.round(ddd * 100) / 100,
  };
}

interface CrossCheckRow {
  algoName: string;
  baseTicker: string;
  testTicker: string;
  stats: Stats;
  pass: boolean;
  reason: string;
}

function gate(stats: Stats): { pass: boolean; reason: string } {
  if (stats.trades === 0) return { pass: false, reason: "zero trades" };
  if (stats.total <= 0) return { pass: false, reason: "negative" };
  if (stats.wr < 37) return { pass: false, reason: `WR ${stats.wr}% < 37` };
  if (stats.sdd >= 10) return { pass: false, reason: `sdd ${stats.sdd}% >= 10` };
  if (stats.ddd >= 5) return { pass: false, reason: `ddd ${stats.ddd}% >= 5` };
  return { pass: true, reason: "all gates pass" };
}

async function main(): Promise<void> {
  console.log(`\n===== STEP 5 — Multi-instrument cross-check @ ${new Date().toISOString().slice(0, 16)} =====\n`);
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const supabase = createClient(url, key, { auth: { persistSession: false } });

  const rows: CrossCheckRow[] = [];
  for (const name of GOLD_SURVIVORS) {
    const algoRes = await supabase.from("algorithms").select("id, capital, rules").eq("name", name).single();
    if (algoRes.error || !algoRes.data) { console.log(`  ${name}: SKIP (not in DB)`); continue; }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const algo = algoRes.data as any as { id: string; capital: number; rules: AlgorithmRules };
    const wl = await supabase.from("algorithm_watchlist").select("ticker").eq("algorithm_id", algo.id);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const baseTicker = ((wl.data ?? []) as any[])[0]?.ticker?.toUpperCase() ?? "";
    const interval = timeframeToInterval(algo.rules.timeframe);

    // Baseline on gold (sanity check)
    const goldBars = await getBarsNoTtl(supabase, baseTicker, interval);
    if (goldBars) {
      const r = runPortfolioBacktest(algo.rules, new Map([[baseTicker, goldBars]]), algo.capital, []);
      const s = computeStats(r.trades, algo.capital);
      const g = gate(s);
      rows.push({ algoName: name, baseTicker, testTicker: baseTicker, stats: s, pass: g.pass, reason: g.reason });
    }

    // Forex cross-checks
    for (const fx of FOREX_TICKERS) {
      const fxBars = await getBarsNoTtl(supabase, fx, interval);
      if (!fxBars) { console.log(`  ${name} on ${fx}: SKIP (no bars at ${interval})`); continue; }
      // Adapt rules: swap asset_class to forex if relevant. The sizing
      // engine uses asset_class + ticker to compute lots/notional. For
      // the test we keep rules identical except ticker. Run with forex
      // bars, gold rules.
      const r = runPortfolioBacktest(algo.rules, new Map([[fx, fxBars]]), algo.capital, []);
      const s = computeStats(r.trades, algo.capital);
      const g = gate(s);
      rows.push({ algoName: name, baseTicker, testTicker: fx, stats: s, pass: g.pass, reason: g.reason });
    }
  }

  console.log(`\n${"=".repeat(130)}`);
  console.log(`${"ALGO".padEnd(48)} ${"TEST INSTRUMENT".padEnd(15)} ${"TOTAL".padStart(10)} ${"TRADES".padStart(7)} ${"WR%".padStart(6)} ${"SDD%".padStart(6)} ${"DDD%".padStart(6)} ${"PASS"}`);
  console.log(`${"=".repeat(130)}`);
  for (const row of rows) {
    const tag = row.pass ? "✓" : "✗";
    console.log(`${row.algoName.padEnd(48)} ${row.testTicker.padEnd(15)} ${("$" + row.stats.total).padStart(10)} ${row.stats.trades.toString().padStart(7)} ${row.stats.wr.toString().padStart(6)} ${row.stats.sdd.toString().padStart(6)} ${row.stats.ddd.toString().padStart(6)}  ${tag} ${row.pass ? "" : "  [" + row.reason + "]"}`);
  }

  // Summary: any forex passes?
  const forexPasses = rows.filter((r) => r.testTicker !== r.baseTicker && r.pass);
  const forexFails = rows.filter((r) => r.testTicker !== r.baseTicker && !r.pass);
  console.log(`\n${"=".repeat(130)}`);
  console.log(`SUMMARY`);
  console.log(`${"=".repeat(130)}`);
  console.log(`  Forex tests passing: ${forexPasses.length} / ${forexPasses.length + forexFails.length}`);
  if (forexPasses.length > 0) {
    console.log(`  PASSING forex configs:`);
    for (const p of forexPasses) console.log(`    ${p.algoName} on ${p.testTicker}: $${p.stats.total} / ${p.stats.trades}t / WR ${p.stats.wr}%`);
    console.log(`  → STEP 5 verdict: forex configs found, queue for promotion`);
  } else {
    console.log(`  → STEP 5 verdict: confirmed gold-tuned configs do NOT generalize to forex. Forex needs new entry conditions (STEP 9 R&D).`);
  }
}

void main();
