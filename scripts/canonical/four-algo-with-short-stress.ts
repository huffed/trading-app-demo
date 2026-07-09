/**
 * 4-algo portfolio FTMO stress test.
 *
 * Extends 3-algo gold portfolio (all Long + daily_bias_bullish) with
 * candidate CHOCH-Short + daily_bias_bearish (the only Short variant
 * passing all hard FTMO+operator gates per comprehensive-daily-bias-sweep).
 *
 * Tests:
 *   - Pairwise Pearson on per-day pnl_R between all 4 algos (correlation gate < 0.40)
 *   - 60-day FTMO challenge stress at multiple risk levels
 *   - Compare 3-algo vs 4-algo:
 *       * Avg return per challenge
 *       * Challenge pass rate
 *       * Worst-case Max Loss + Daily Loss breaches
 *
 * Outputs verdict: KEEP 3-algo OR EXPAND to 4-algo at recommended risk %.
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

interface AlgoSpec { id: string; name: string; bias_dir: "bullish" | "bearish"; }
const ALGOS_3: AlgoSpec[] = [
  { id: "069813f1-2a80-48e7-a086-5bf22c05e300", name: "ARB rr3_lb3_r06_rf1_af0", bias_dir: "bullish" },
  { id: "daff0052-824a-4cd4-a43c-7fd177fe8513", name: "Engulfing rr3_lb6_r1_rf0_af1", bias_dir: "bullish" },
  { id: "85d421e6-bcc9-40b5-9ee4-be1e7d6fea03", name: "ARB rr25_lb3_r06_rf1_af0", bias_dir: "bullish" },
];
const ALGO_CHOCH_SHORT: AlgoSpec = {
  id: "9d5bbb17-24a7-42bb-9393-ebfa06e2b6f1",
  name: "CHOCH-Short Layer-A baseline",
  bias_dir: "bearish",
};

async function loadAlgoTrades(sb: SupabaseClient<Database>, spec: AlgoSpec, bars: PriceBar[], riskPct: number): Promise<BacktestTrade[]> {
  const { data: row } = await sb.from("algorithms").select("rules").eq("id", spec.id).maybeSingle();
  if (!row) throw new Error(`algo ${spec.id} not found`);
  const baseRules = row.rules as unknown as AlgorithmRules;
  const augmentedEC: EntryCondition[] = [
    ...baseRules.entry_conditions,
    { type: "pattern", pattern: "daily_bias", direction: spec.bias_dir, ma_period: 20, timeframe: "1d" } as EntryCondition,
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

function dailyPnlSeries(trades: BacktestTrade[], startMs: number, endMs: number): Map<string, number> {
  const series = new Map<string, number>();
  for (const t of trades) {
    const day = t.exit_date.slice(0, 10);
    series.set(day, (series.get(day) ?? 0) + t.pnl);
  }
  const dayMs = 24 * 3600 * 1000;
  for (let d = startMs; d <= endMs; d += dayMs) {
    const iso = new Date(d).toISOString().slice(0, 10);
    if (!series.has(iso)) series.set(iso, 0);
  }
  return series;
}

function pearson(a: number[], b: number[]): number {
  const n = a.length;
  if (n === 0 || b.length !== n) return 0;
  const ma = a.reduce((s, x) => s + x, 0) / n;
  const mb = b.reduce((s, x) => s + x, 0) / n;
  let num = 0, denA = 0, denB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - ma, db = b[i] - mb;
    num += da * db; denA += da * da; denB += db * db;
  }
  const denom = Math.sqrt(denA * denB);
  return denom === 0 ? 0 : num / denom;
}

async function main(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const sb = createClient<Database>(url, key);
  const interval = timeframeToInterval("4h");
  const { data: bd } = await sb.from("price_cache").select("bars")
    .eq("ticker", "XAU/USD").eq("output_size", "full").eq("interval", interval).limit(1).single();
  const bars = bd!.bars as unknown as PriceBar[];

  console.log("4-algo expansion study (3 long deployed + 1 short candidate)");
  console.log(`Pool capital: $${POOL_CAPITAL}, ${CHALLENGE_DAYS}-day FTMO challenge windows`);
  console.log("");

  // Step 1: load trades for all 4 at 0.80% risk (current portfolio level)
  console.log("=== STEP 1: Load trades per algo at 0.80% risk ===");
  const RISK_REF = 0.80;
  const tradesById = new Map<string, BacktestTrade[]>();
  for (const a of [...ALGOS_3, ALGO_CHOCH_SHORT]) {
    const t = await loadAlgoTrades(sb, a, bars, RISK_REF);
    tradesById.set(a.id, t);
    // BacktestTrade has no r_multiple field — this always summed to 0 in the
    // as-run 2026-06-29 output too (tsx doesn't type-check; next build does).
    const totalR = t.reduce((s, x) => s + ((x as { r_multiple?: number }).r_multiple ?? 0), 0);
    const totalPnl = t.reduce((s, x) => s + x.pnl, 0);
    console.log(`  ${a.name.padEnd(45)} trades=${t.length.toString().padStart(3)} total_R=${totalR.toFixed(1).padStart(6)} total_$=${totalPnl.toFixed(0).padStart(6)}`);
  }
  console.log("");

  // Step 2: pairwise Pearson on per-day pnl_R
  console.log("=== STEP 2: Pairwise Pearson correlation on per-day pnl_$ ===");
  const algos = [...ALGOS_3, ALGO_CHOCH_SHORT];
  let firstMs = Infinity, lastMs = -Infinity;
  for (const a of algos) {
    for (const t of tradesById.get(a.id)!) {
      const ms = Date.parse(t.exit_date);
      if (ms < firstMs) firstMs = ms;
      if (ms > lastMs) lastMs = ms;
    }
  }
  const series = algos.map((a) => dailyPnlSeries(tradesById.get(a.id)!, firstMs, lastMs));
  const sortedDays = [...series[0].keys()].sort();
  const arrays = series.map((s) => sortedDays.map((d) => s.get(d) ?? 0));

  console.log(`Day range: ${sortedDays[0]} → ${sortedDays[sortedDays.length - 1]} (${sortedDays.length} days)`);
  console.log("");
  console.log("          " + algos.map((_, i) => `algo${i + 1}`.padStart(8)).join(""));
  let anyHigh = false;
  for (let i = 0; i < algos.length; i++) {
    const row: string[] = [];
    for (let j = 0; j < algos.length; j++) {
      if (i === j) row.push("    1.00");
      else {
        const r = pearson(arrays[i], arrays[j]);
        const flag = Math.abs(r) >= 0.40 ? "⚠" : " ";
        if (i < j && Math.abs(r) >= 0.40) anyHigh = true;
        row.push(`${flag}${r.toFixed(3).padStart(7)}`);
      }
    }
    console.log(`  algo${i + 1}: ` + row.join(""));
  }
  console.log("");
  for (let i = 0; i < algos.length; i++) console.log(`  algo${i + 1} = ${algos[i].name}`);
  console.log("");
  if (anyHigh) console.log("  ⚠ At least one pair correlation |ρ|≥0.40 — composer's diversification gate would fail.");
  else console.log("  ✓ All pairwise |ρ|<0.40 — diversification gate clean.");
  console.log("");

  // Step 3: 4-algo FTMO stress at multiple risk levels
  console.log("=== STEP 3: 4-algo portfolio FTMO challenge stress ===");
  for (const r of [0.50, 0.65, 0.80, 1.00]) {
    const allTrades: BacktestTrade[] = [];
    for (const a of algos) {
      const t = await loadAlgoTrades(sb, a, bars, r);
      allTrades.push(...t);
    }
    const st = stressTest(allTrades, POOL_CAPITAL);
    const passRate = (st.pass / st.total) * 100;
    const breachRate = ((st.fail_max_loss + st.fail_daily) / st.total) * 100;
    console.log(`  risk ${r.toFixed(2)}% each | trades=${allTrades.length.toString().padStart(3)} | pass=${st.pass.toString().padStart(3)} (${passRate.toFixed(1).padStart(4)}%) | breach=${(st.fail_max_loss + st.fail_daily).toString().padStart(2)}/${st.total} (${breachRate.toFixed(1)}%) | worst ML=${st.worst_max_loss.toFixed(2).padStart(5)}% DL=${st.worst_daily.toFixed(2).padStart(4)}% | avg return=${st.avg_return_pct.toFixed(2).padStart(5)}%`);
  }
  console.log("");

  // Step 4: 3-algo baseline at same levels (comparison)
  console.log("=== STEP 4: 3-algo BASELINE (for comparison) ===");
  for (const r of [0.50, 0.65, 0.80, 1.00]) {
    const allTrades: BacktestTrade[] = [];
    for (const a of ALGOS_3) {
      const t = await loadAlgoTrades(sb, a, bars, r);
      allTrades.push(...t);
    }
    const st = stressTest(allTrades, POOL_CAPITAL);
    const passRate = (st.pass / st.total) * 100;
    const breachRate = ((st.fail_max_loss + st.fail_daily) / st.total) * 100;
    console.log(`  risk ${r.toFixed(2)}% each | trades=${allTrades.length.toString().padStart(3)} | pass=${st.pass.toString().padStart(3)} (${passRate.toFixed(1).padStart(4)}%) | breach=${(st.fail_max_loss + st.fail_daily).toString().padStart(2)}/${st.total} (${breachRate.toFixed(1)}%) | worst ML=${st.worst_max_loss.toFixed(2).padStart(5)}% DL=${st.worst_daily.toFixed(2).padStart(4)}% | avg return=${st.avg_return_pct.toFixed(2).padStart(5)}%`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
