/**
 * 5-algo expansion candidates: test if adding a 5th to current 4-algo improves.
 *
 * Candidates considered (close-to-passing in comprehensive-daily-bias-sweep):
 *   - Sweep-Reclaim-Long  + daily_bias_bullish (WR 36.6%, DD 11.89% @1% → 9.5% @0.80%)
 *   - EqualLevels-Long    + daily_bias_bullish (WR 36.9%, DD 8.38%, marginal WR — within noise)
 *   - AsianRangeBreak-Long + daily_bias_bullish (WR 36.6%, DD 15.95% @1% → 12.8% @0.80% — too high)
 *   - BOS-Long            + daily_bias_bullish (WR 38.7%, DD 14.50% @1% → 11.6% @0.80% — over)
 *   - Momentum-Long       + daily_bias_bullish (WR 37.7%, DD 16.26% @1% → 13.0% @0.80% — over)
 *
 * Per candidate: (a) load trades at 0.80%, (b) compute pairwise Pearson vs
 * current 4, (c) run 5-algo FTMO challenge stress, (d) compare vs 4-algo.
 *
 * Verdict: ADD candidates whose 5-algo stress shows non-deteriorating worst-
 * case ML/DL + similar-or-higher pass rate + low correlation (|ρ|<0.40 vs all).
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
const RISK = 0.80;

interface AlgoSpec { id: string; name: string; bias_dir: "bullish" | "bearish"; }
const CURRENT_4: AlgoSpec[] = [
  { id: "069813f1-2a80-48e7-a086-5bf22c05e300", name: "ARB rr3_lb3", bias_dir: "bullish" },
  { id: "daff0052-824a-4cd4-a43c-7fd177fe8513", name: "Engulfing rr3_lb6", bias_dir: "bullish" },
  { id: "85d421e6-bcc9-40b5-9ee4-be1e7d6fea03", name: "ARB rr25_lb3", bias_dir: "bullish" },
  { id: "9d5bbb17-24a7-42bb-9393-ebfa06e2b6f1", name: "CHOCH-Short LayerA", bias_dir: "bearish" },
];

async function findLayerAByName(sb: SupabaseClient<Database>, namePart: string): Promise<{ id: string; name: string } | null> {
  const { data } = await sb.from("algorithms").select("id, name").like("name", `Search: XAU/USD ${namePart}%4h`).limit(1).maybeSingle();
  return data;
}

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

  console.log("5-algo expansion: candidate scan vs current 4-algo deploy");
  console.log(`Pool $${POOL_CAPITAL}, ${CHALLENGE_DAYS}-day FTMO challenges, risk ${RISK}% each`);
  console.log("");

  // Resolve candidate IDs
  const CANDIDATE_NAMES = [
    { partial: "Sweep-Reclaim-Long ", dir: "bullish" as const },
    { partial: "EqualLevels-Long ", dir: "bullish" as const },
    { partial: "AsianRangeBreak-Long ", dir: "bullish" as const },
    { partial: "OutsideBar-Long ", dir: "bullish" as const },
    { partial: "InsideBar-Long ", dir: "bullish" as const },
    { partial: "OrderBlock-Long ", dir: "bullish" as const },
    { partial: "OTE-Long ", dir: "bullish" as const },
    { partial: "FVG-Long ", dir: "bullish" as const },
  ];
  const candidates: AlgoSpec[] = [];
  for (const c of CANDIDATE_NAMES) {
    const row = await findLayerAByName(sb, c.partial);
    if (!row) { console.log(`  ⚠ Candidate not found: ${c.partial}`); continue; }
    candidates.push({ id: row.id, name: row.name.replace("Search: XAU/USD ", ""), bias_dir: c.dir });
  }

  // Baseline: 4-algo stress
  console.log("=== BASELINE: current 4-algo deploy ===");
  const baseline4Trades: BacktestTrade[] = [];
  const trades4ById: Record<string, BacktestTrade[]> = {};
  for (const a of CURRENT_4) {
    const t = await loadAlgoTrades(sb, a, bars, RISK);
    baseline4Trades.push(...t);
    trades4ById[a.id] = t;
  }
  const base = stressTest(baseline4Trades, POOL_CAPITAL);
  console.log(`  trades=${baseline4Trades.length} pass=${base.pass}/${base.total} (${(base.pass/base.total*100).toFixed(1)}%) breach=${base.fail_max_loss+base.fail_daily} worst_ML=${base.worst_max_loss.toFixed(2)}% worst_DL=${base.worst_daily.toFixed(2)}% avg=${base.avg_return_pct.toFixed(2)}%`);
  console.log("");

  // Compute time range for correlation series
  let firstMs = Infinity, lastMs = -Infinity;
  for (const t of baseline4Trades) {
    const ms = Date.parse(t.exit_date);
    if (ms < firstMs) firstMs = ms;
    if (ms > lastMs) lastMs = ms;
  }
  const seriesCurrent4 = CURRENT_4.map((a) => dailyPnlSeries(trades4ById[a.id], firstMs, lastMs));
  const sortedDays = [...seriesCurrent4[0].keys()].sort();
  const arrays4 = seriesCurrent4.map((s) => sortedDays.map((d) => s.get(d) ?? 0));

  // Per-candidate test
  console.log("=== 5-ALGO EXPANSION CANDIDATES ===");
  const results: Array<{ name: string; pass: number; total: number; breach: number; worstML: number; worstDL: number; avgReturn: number; maxCorr: number; passes_gates: boolean; deltaReturn: number; deltaPass: number; }> = [];
  for (const cand of candidates) {
    const candTrades = await loadAlgoTrades(sb, cand, bars, RISK);
    const candSeries = dailyPnlSeries(candTrades, firstMs, lastMs);
    const candArr = sortedDays.map((d) => candSeries.get(d) ?? 0);
    const corrs = arrays4.map((a) => pearson(candArr, a));
    const maxCorr = Math.max(...corrs.map(Math.abs));

    const all5 = [...baseline4Trades, ...candTrades];
    const st = stressTest(all5, POOL_CAPITAL);
    const breach = st.fail_max_loss + st.fail_daily;
    const passes = st.worst_max_loss <= 10 && st.worst_daily <= 5 && breach === 0 && maxCorr < 0.40;
    const deltaReturn = st.avg_return_pct - base.avg_return_pct;
    const deltaPass = (st.pass / st.total - base.pass / base.total) * 100;
    results.push({
      name: cand.name, pass: st.pass, total: st.total, breach, worstML: st.worst_max_loss, worstDL: st.worst_daily,
      avgReturn: st.avg_return_pct, maxCorr, passes_gates: passes, deltaReturn, deltaPass,
    });
    const verdict = passes ? "✓ PASS" : "✗ FAIL";
    console.log(`  ${cand.name.padEnd(40)} | trades=${candTrades.length.toString().padStart(3)} | 5algo: ML=${st.worst_max_loss.toFixed(2).padStart(5)}% DL=${st.worst_daily.toFixed(2).padStart(4)}% breach=${breach} pass=${(st.pass/st.total*100).toFixed(1).padStart(4)}% ret=${st.avg_return_pct.toFixed(2).padStart(5)}% | maxCorr=${maxCorr.toFixed(3)} | Δret=${deltaReturn >= 0 ? "+" : ""}${deltaReturn.toFixed(2)} ${verdict}`);
  }
  console.log("");
  console.log("=== VERDICT ===");
  const winners = results.filter((r) => r.passes_gates && r.deltaReturn > 0);
  if (winners.length === 0) console.log("  No 5th-algo candidate passes all gates. KEEP 4-algo.");
  else {
    winners.sort((a, b) => b.deltaReturn - a.deltaReturn);
    console.log(`  ${winners.length} candidate(s) qualify as 5th algo:`);
    for (const w of winners) {
      console.log(`    ${w.name} — Δret +${w.deltaReturn.toFixed(2)}%/window, maxCorr ${w.maxCorr.toFixed(3)}, worst_ML ${w.worstML.toFixed(2)}%`);
    }
    console.log(`  → ADD: ${winners[0].name} (top by Δreturn)`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
