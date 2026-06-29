/**
 * Multi-algo portfolio stress-test with CORRECT FTMO Max Loss metric
 * (fixed floor, not peak-to-trough) + 60-day challenge windows.
 *
 * Tests whether running multiple top FTMO-passers at scaled risk
 * outperforms single-algo deploy at 1.25% risk on:
 *   - Return per FTMO-compliance buffer
 *   - Challenge pass rate
 *
 * Operator's stated target: 1%/mo gold portfolio. Single algo already
 * delivers ~1.40%/mo. Question: does adding more algos improve enough
 * to justify operational complexity?
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { timeframeToInterval } from "../../src/lib/market-data/interval";
import { runPortfolioBacktest } from "../../src/lib/market-data/portfolio-backtest";
import type { Database } from "../../src/lib/supabase/database.types";
import type { BacktestTrade, PriceBar } from "../../src/lib/market-data/types";
import type { AlgorithmRules, EntryCondition } from "../../src/types/algorithm";

function loadEnvLocal(): void {
  try {
    const envText = readFileSync(resolve(process.cwd(), ".env.local"), "utf-8");
    for (const line of envText.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      if (!(key in process.env)) process.env[key] = val;
    }
  } catch {}
}
loadEnvLocal();

const POOL_CAPITAL = 10000;
const CHALLENGE_DAYS = 60;
const STEP_DAYS = 7;

interface AlgoSpec { id: string; name: string; }
const ALGOS: AlgoSpec[] = [
  { id: "069813f1-2a80-48e7-a086-5bf22c05e300", name: "ARB rr3_lb3_r06_rf1_af0" },
  { id: "daff0052-824a-4cd4-a43c-7fd177fe8513", name: "Engulfing rr3_lb6_r1_rf0_af1" },
  { id: "85d421e6-bcc9-40b5-9ee4-be1e7d6fea03", name: "ARB rr25_lb3_r06_rf1_af0" },
];

async function loadAlgoTrades(sb: SupabaseClient<Database>, id: string, bars: PriceBar[], riskPct: number): Promise<BacktestTrade[]> {
  const { data: row } = await sb.from("algorithms").select("rules").eq("id", id).maybeSingle();
  if (!row) throw new Error(`algo ${id} not found`);
  const baseRules = row.rules as unknown as AlgorithmRules;
  const augmentedEC: EntryCondition[] = [
    ...baseRules.entry_conditions,
    { type: "pattern", pattern: "daily_bias", direction: "bullish", ma_period: 20, timeframe: "1d" } as EntryCondition,
  ];
  const rules: AlgorithmRules = {
    ...baseRules, entry_conditions: augmentedEC, entry_logic: "all",
    position_sizing: { ...baseRules.position_sizing, type: "risk_per_trade", value: riskPct },
  };
  const result = runPortfolioBacktest(rules, new Map([["XAU/USD", bars]]), POOL_CAPITAL);
  return result.trades ?? [];
}

interface ChallengeResult { pass: number; fail_max_loss: number; fail_daily: number; total: number; worst_max_loss: number; worst_daily: number; avg_return_pct: number; }

function stressTest(allTrades: BacktestTrade[], initialCapital: number): ChallengeResult {
  if (allTrades.length === 0) return { pass: 0, fail_max_loss: 0, fail_daily: 0, total: 0, worst_max_loss: 0, worst_daily: 0, avg_return_pct: 0 };
  const sorted = [...allTrades].sort((a, b) => a.exit_date.localeCompare(b.exit_date));
  const firstMs = Date.parse(sorted[0].exit_date);
  const lastMs = Date.parse(sorted[sorted.length - 1].exit_date);
  const dayMs = 24 * 3600 * 1000;
  const windowMs = CHALLENGE_DAYS * dayMs;
  let pass = 0, failML = 0, failDL = 0, total = 0;
  let worstML = 0, worstDL = 0;
  let sumReturn = 0;
  for (let startMs = firstMs; startMs + windowMs <= lastMs; startMs += STEP_DAYS * dayMs) {
    const endMs = startMs + windowMs;
    const winTrades = sorted.filter((t) => {
      const e = Date.parse(t.exit_date);
      return e >= startMs && e <= endMs;
    });
    let equity = initialCapital, minEquity = initialCapital, profitHit = false, mlBreached = false;
    const dailyPnl = new Map<string, number>();
    for (const t of winTrades) {
      const day = t.exit_date.slice(0, 10);
      dailyPnl.set(day, (dailyPnl.get(day) ?? 0) + t.pnl);
      equity += t.pnl;
      if (equity < minEquity) minEquity = equity;
      if (equity <= initialCapital * 0.9) mlBreached = true;
      if (equity >= initialCapital * 1.1) profitHit = true;
    }
    let worstDailyLoss = 0;
    for (const pnl of dailyPnl.values()) if (pnl < 0 && Math.abs(pnl) > worstDailyLoss) worstDailyLoss = Math.abs(pnl);
    const dlBreached = worstDailyLoss > initialCapital * 0.05;
    const mlPct = Math.max(0, (initialCapital - minEquity) / initialCapital * 100);
    const dlPct = (worstDailyLoss / initialCapital) * 100;
    if (mlPct > worstML) worstML = mlPct;
    if (dlPct > worstDL) worstDL = dlPct;
    total++;
    if (mlBreached) failML++;
    else if (dlBreached) failDL++;
    else if (profitHit) pass++;
    sumReturn += ((equity - initialCapital) / initialCapital) * 100;
  }
  return { pass, fail_max_loss: failML, fail_daily: failDL, total, worst_max_loss: worstML, worst_daily: worstDL, avg_return_pct: sumReturn / total };
}

async function main(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const sb = createClient<Database>(url, key);
  const interval = timeframeToInterval("4h");
  const { data: bd } = await sb.from("price_cache").select("bars")
    .eq("ticker", "XAU/USD").eq("output_size", "full").eq("interval", interval).limit(1).single();
  const bars = bd!.bars as unknown as PriceBar[];

  console.log(`Multi-algo FTMO stress test (${CHALLENGE_DAYS}-day challenge windows, FTMO 10% floor + 5% daily)`);
  console.log(`Pool capital: $${POOL_CAPITAL}, ${ALGOS.length} algos all augmented with daily_bias_bullish`);
  console.log("");

  // Single algo @ 1.25% (current deploy)
  console.log("=== BASELINE: SINGLE deployed algo at 1.25% risk ===");
  const singleTrades = await loadAlgoTrades(sb, ALGOS[0].id, bars, 1.25);
  const singleStress = stressTest(singleTrades, POOL_CAPITAL);
  console.log(`  trades=${singleTrades.length} | pass=${singleStress.pass} (${((singleStress.pass/singleStress.total)*100).toFixed(1)}%) | ML breach=${singleStress.fail_max_loss}/${singleStress.total} | DL breach=${singleStress.fail_daily}/${singleStress.total}`);
  console.log(`  worst ML=${singleStress.worst_max_loss.toFixed(2)}% | worst DL=${singleStress.worst_daily.toFixed(2)}% | avg return per challenge=${singleStress.avg_return_pct.toFixed(2)}%`);
  console.log("");

  // Multi-algo at uniform risk (3 algos)
  console.log("=== MULTI-ALGO PORTFOLIO: 3 algos at uniform risk ===");
  for (const r of [0.50, 0.65, 0.80, 1.00]) {
    const allTrades: BacktestTrade[] = [];
    for (const a of ALGOS) {
      const t = await loadAlgoTrades(sb, a.id, bars, r);
      allTrades.push(...t);
    }
    const st = stressTest(allTrades, POOL_CAPITAL);
    console.log(`  risk ${r.toFixed(2)}% each (${allTrades.length} total trades):`);
    console.log(`    pass=${st.pass} (${((st.pass/st.total)*100).toFixed(1)}%) | ML breach=${st.fail_max_loss}/${st.total} | DL breach=${st.fail_daily}/${st.total}`);
    console.log(`    worst ML=${st.worst_max_loss.toFixed(2)}% | worst DL=${st.worst_daily.toFixed(2)}% | avg return=${st.avg_return_pct.toFixed(2)}%`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
