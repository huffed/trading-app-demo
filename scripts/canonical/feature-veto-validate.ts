/**
 * H.4-methodology-revision — Feature-as-filter validator for pattern-
 * triggered algos.
 *
 * Operator-approved 2026-06-24 replacement for the AUC ≥ 0.55 gate when
 * the target algo is pattern-triggered (per `classifyAlgoForGate`).
 *
 * Method:
 *   1. Load target algo (default = v3 survivor) + bars
 *   2. Run baseline backtest → record total_R, Sharpe, max-static-DD
 *   3. Load top-K features from feature-importance-results.json
 *   4. For each top-K feature × {veto-high, veto-low}:
 *      a. Compute feature value at each trade's entry bar
 *      b. Compute median across all trades' values
 *      c. veto-high variant = drop trades where feature_value > median
 *      d. veto-low variant = drop trades where feature_value < median
 *      e. Recompute total_R + Sharpe + max-DD on remaining trades
 *   5. Report per-feature × per-direction delta-Sharpe + delta-DD vs baseline
 *
 * Gate (pre-registered): ≥1 feature × direction improves Sharpe by
 * ≥5% OR cuts max-DD by ≥20% relative to baseline → PASS.
 *
 * Post-hoc filtering rationale: pattern-triggered algos have no path
 * dependency in entry decisions (pattern firing depends on bars, NOT on
 * prior trades). So filtering trades after the fact gives a valid
 * preview of what an in-engine veto would produce. If the gate PASSES,
 * the operator can then wire the winning feature into the algo's rules
 * as a real entry filter + re-run validate-algo for proper deflation.
 *
 * Persists scripts/canonical/feature-veto-validate-results.json with
 * full per-feature deltas + verdict.
 *
 * Wall clock: ~10 seconds (1 baseline backtest + post-hoc filtering).
 *
 * Usage:
 *   pnpm dlx tsx scripts/canonical/feature-veto-validate.ts
 *   ALGO_ID=<uuid> TOP_K=10 SHARPE_GATE=5 DD_GATE=20 \
 *     pnpm dlx tsx scripts/canonical/feature-veto-validate.ts
 *
 * Env:
 *   ALGO_ID                  default v3 survivor 33b705b9-...
 *   TOP_K                    default 10 (number of top features to test)
 *   SHARPE_PCT_GATE          default 5  (Sharpe improvement % to pass on its own)
 *   DD_PCT_CUT_GATE          default 20 (max-DD cut % to pass on its own)
 *   FEATURE_IMPORTANCE_FILE  default scripts/canonical/feature-importance-results.json
 *   OUTPUT_JSON              default scripts/canonical/feature-veto-validate-results.json
 *   PERSIST                  default 1
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { classifyAlgoForGate } from "../../src/lib/algo-search/criteria";
import { FEATURES, type FeatureContext } from "../../src/lib/features";
import { timeframeToInterval } from "../../src/lib/market-data/interval";
import { runPortfolioBacktest } from "../../src/lib/market-data/portfolio-backtest";
import { resampleToDaily } from "../../src/lib/market-data/resample";
import type { Database } from "../../src/lib/supabase/database.types";
import type { BacktestTrade, PriceBar } from "../../src/lib/market-data/types";
import type { AlgorithmRules } from "../../src/types/algorithm";

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
  } catch { /* operator exports envs themselves */ }
}
loadEnvLocal();

const ALGO_ID = process.env.ALGO_ID ?? "33b705b9-7442-4c73-8d97-4a88ecacb9a1";
const TOP_K = Math.max(1, Number(process.env.TOP_K ?? "10"));
const SHARPE_PCT_GATE = Number(process.env.SHARPE_PCT_GATE ?? "5");
const DD_PCT_CUT_GATE = Number(process.env.DD_PCT_CUT_GATE ?? "20");
const FEATURE_IMPORTANCE_FILE =
  process.env.FEATURE_IMPORTANCE_FILE ?? "scripts/canonical/feature-importance-results.json";
const OUTPUT_JSON =
  process.env.OUTPUT_JSON ?? "scripts/canonical/feature-veto-validate-results.json";
const PERSIST = process.env.PERSIST !== "0";

function fail(msg: string): never {
  console.error(`[feature-veto-validate] ${msg}`);
  process.exit(1);
}

function requireEnv(): { url: string; key: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) fail("NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY required");
  return { url, key };
}

function riskDollarsFor(rules: AlgorithmRules, capital: number): number {
  const sizing = rules.position_sizing;
  if (sizing?.type === "risk_per_trade") return capital * (sizing.value / 100);
  return capital * 0.01;
}

interface BarIndex { idx: number; date: string }

function indexBarsByDate(bars: PriceBar[]): Map<string, number> {
  const out = new Map<string, number>();
  for (let i = 0; i < bars.length; i++) out.set(bars[i].date, i);
  return out;
}

/** Normalize entry_date to bar.date format (some BacktestTrade rows
 *  emit ISO Z; bars store "YYYY-MM-DD HH:MM:SS"). */
function normaliseDate(d: string): string {
  if (d.includes("T")) return new Date(d).toISOString().slice(0, 19).replace("T", " ");
  return d;
}

function entryBarIdx(trade: BacktestTrade, idx: Map<string, number>): number | null {
  const direct = idx.get(trade.entry_date);
  if (direct !== undefined) return direct;
  const normalised = idx.get(normaliseDate(trade.entry_date));
  return normalised ?? null;
}

interface Metrics {
  trades: number;
  total_r: number;
  mean_r: number;
  sharpe: number;
  max_dd_r: number;
}

function computeMetrics(trades: readonly BacktestTrade[], riskDollars: number): Metrics {
  if (trades.length === 0 || riskDollars <= 0) {
    return { trades: 0, total_r: 0, mean_r: 0, sharpe: 0, max_dd_r: 0 };
  }
  const r = trades.map((t) => t.pnl / riskDollars);
  const total = r.reduce((a, b) => a + b, 0);
  const mean = total / r.length;
  let var_ = 0;
  for (const x of r) var_ += (x - mean) ** 2;
  const std = Math.sqrt(var_ / r.length);
  const sharpe = std === 0 ? 0 : mean / std;
  // Max drawdown on cumulative R-equity
  let peak = 0;
  let equity = 0;
  let maxDd = 0;
  for (const x of r) {
    equity += x;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDd) maxDd = dd;
  }
  return { trades: trades.length, total_r: total, mean_r: mean, sharpe, max_dd_r: maxDd };
}

function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

interface FeatureImportanceFile {
  top_features?: Array<{ name: string; gain: number }>;
  all_features?: Array<{ name: string; gain: number }>;
}

interface PerFeatureResult {
  feature: string;
  rank_by_h3_gain: number;
  median_value: number | null;
  // veto-high: drop trades where feature > median
  veto_high: { metrics: Metrics; delta_sharpe_pct: number; delta_dd_pct: number; passes: boolean } | null;
  // veto-low: drop trades where feature < median
  veto_low: { metrics: Metrics; delta_sharpe_pct: number; delta_dd_pct: number; passes: boolean } | null;
  skipped_reason?: string;
}

async function loadAlgo(supabase: SupabaseClient<Database>): Promise<{
  id: string;
  name: string;
  rules: AlgorithmRules;
  capital: number;
  ticker: string;
  timeframe: string;
}> {
  const { data, error } = await supabase
    .from("algorithms")
    .select("id, name, rules, capital, algorithm_watchlist(ticker)")
    .eq("id", ALGO_ID)
    .single();
  if (error || !data) fail(`Failed to fetch algo ${ALGO_ID}: ${error?.message ?? "no row"}`);
  const rules = data.rules as unknown as AlgorithmRules;
  const watchlist = (data.algorithm_watchlist ?? []) as { ticker: string }[];
  if (watchlist.length === 0) fail(`Algo has no watchlist tickers`);
  return {
    id: data.id,
    name: data.name,
    rules,
    capital: Number(data.capital),
    ticker: watchlist[0].ticker,
    timeframe: rules.timeframe,
  };
}

async function loadBars(
  supabase: SupabaseClient<Database>,
  ticker: string,
  timeframe: string,
): Promise<PriceBar[]> {
  const interval = timeframeToInterval(timeframe);
  const { data, error } = await supabase
    .from("price_cache")
    .select("bars")
    .eq("ticker", ticker.toUpperCase())
    .eq("output_size", "full")
    .eq("interval", interval)
    .limit(1)
    .single();
  if (error || !data) fail(`No cached bars for ${ticker} ${interval}: ${error?.message}`);
  return data.bars as unknown as PriceBar[];
}

async function main(): Promise<void> {
  const { url, key } = requireEnv();
  const supabase = createClient<Database>(url, key);

  console.log(`[feature-veto-validate] H.4-methodology-revision — pattern-triggered feature-as-filter test`);
  console.log(`  algo_id : ${ALGO_ID}`);
  console.log(`  top_k   : ${TOP_K}`);
  console.log(`  Sharpe gate : Δ ≥ +${SHARPE_PCT_GATE}%`);
  console.log(`  DD gate     : Δ ≤ -${DD_PCT_CUT_GATE}%`);
  console.log("");

  const algo = await loadAlgo(supabase);

  const algoClass = classifyAlgoForGate(algo.rules as { entry_conditions?: Array<{ type?: string }> });
  console.log(`  Algo class: ${algoClass}`);
  if (algoClass !== "pattern-triggered") {
    console.log("");
    console.log(`  ⚠ Algo class is NOT pattern-triggered — feature-veto framing may not apply.`);
    console.log(`     For direction-predictive algos, use the AUC ≥ 0.55 gate instead.`);
    console.log(`     Continuing anyway since the operator may want diagnostic output.`);
  }

  const bars = await loadBars(supabase, algo.ticker, algo.timeframe);
  console.log(`  ${bars.length} bars (${bars[0]?.date} → ${bars[bars.length - 1]?.date})`);

  console.log("");
  console.log("Running baseline backtest...");
  const pricesByTicker = new Map<string, PriceBar[]>([[algo.ticker.toUpperCase(), bars]]);
  const result = runPortfolioBacktest(algo.rules, pricesByTicker, algo.capital);
  const trades = result.trades ?? [];
  const riskDollars = riskDollarsFor(algo.rules, algo.capital);
  const baseline = computeMetrics(trades, riskDollars);
  console.log(`  baseline: trades=${baseline.trades} total_r=${baseline.total_r.toFixed(2)} sharpe=${baseline.sharpe.toFixed(4)} max_dd_r=${baseline.max_dd_r.toFixed(2)}`);

  if (trades.length < 30) {
    console.log("");
    console.log(`⚠ baseline only ${trades.length} trades — feature-veto split + recompute may not be statistically meaningful (need ≥30).`);
  }

  // Load top-K features
  if (!existsSync(FEATURE_IMPORTANCE_FILE)) {
    fail(`feature-importance-results.json not found at ${FEATURE_IMPORTANCE_FILE}; run H.3 first.`);
  }
  const importanceRaw = readFileSync(FEATURE_IMPORTANCE_FILE, "utf-8");
  const importance: FeatureImportanceFile = JSON.parse(importanceRaw);
  const topFeatureNames = (importance.top_features ?? importance.all_features ?? [])
    .slice(0, TOP_K)
    .map((f) => f.name);
  if (topFeatureNames.length === 0) fail(`feature-importance file has no top_features list`);
  console.log("");
  console.log(`Top-${TOP_K} features from H.3:`);
  for (let i = 0; i < topFeatureNames.length; i++) console.log(`  ${i + 1}. ${topFeatureNames[i]}`);

  const featuresByName = new Map(FEATURES.map((f) => [f.name, f]));
  const barIdx = indexBarsByDate(bars);
  const higherTfBars = resampleToDaily(bars);
  const ctx: FeatureContext = { higherTfBars };

  console.log("");
  console.log("Computing feature values at each trade's entry bar + post-hoc filtering...");
  const perFeature: PerFeatureResult[] = [];

  for (let r = 0; r < topFeatureNames.length; r++) {
    const name = topFeatureNames[r];
    const feature = featuresByName.get(name);
    if (!feature) {
      perFeature.push({
        feature: name,
        rank_by_h3_gain: r + 1,
        median_value: null,
        veto_high: null,
        veto_low: null,
        skipped_reason: "feature not in current FEATURES registry",
      });
      continue;
    }

    // Compute feature value at each trade's entry bar
    const valuesByTradeIdx: Array<{ tradeIdx: number; value: number | null }> = [];
    for (let i = 0; i < trades.length; i++) {
      const entryIdx = entryBarIdx(trades[i], barIdx);
      if (entryIdx === null) {
        valuesByTradeIdx.push({ tradeIdx: i, value: null });
        continue;
      }
      let value: number | null;
      try {
        value = feature.compute(bars, entryIdx, ctx);
      } catch {
        value = null;
      }
      valuesByTradeIdx.push({ tradeIdx: i, value });
    }
    const nonNullValues = valuesByTradeIdx
      .filter((v) => v.value !== null)
      .map((v) => v.value as number);
    if (nonNullValues.length < 10) {
      perFeature.push({
        feature: name,
        rank_by_h3_gain: r + 1,
        median_value: null,
        veto_high: null,
        veto_low: null,
        skipped_reason: `only ${nonNullValues.length} non-null values across trades`,
      });
      continue;
    }
    const med = median(nonNullValues);

    // veto-high: KEEP trades where feature <= median
    const vetoHighTrades: BacktestTrade[] = [];
    for (const v of valuesByTradeIdx) {
      if (v.value === null) continue; // also drop null-value trades from veto-applied variant
      if (v.value <= med) vetoHighTrades.push(trades[v.tradeIdx]);
    }
    // veto-low: KEEP trades where feature >= median
    const vetoLowTrades: BacktestTrade[] = [];
    for (const v of valuesByTradeIdx) {
      if (v.value === null) continue;
      if (v.value >= med) vetoLowTrades.push(trades[v.tradeIdx]);
    }

    const vh = computeMetrics(vetoHighTrades, riskDollars);
    const vl = computeMetrics(vetoLowTrades, riskDollars);

    const dSharpePctVH = baseline.sharpe === 0 ? 0 : ((vh.sharpe - baseline.sharpe) / baseline.sharpe) * 100;
    const dDdPctVH = baseline.max_dd_r === 0 ? 0 : ((vh.max_dd_r - baseline.max_dd_r) / baseline.max_dd_r) * 100;
    const dSharpePctVL = baseline.sharpe === 0 ? 0 : ((vl.sharpe - baseline.sharpe) / baseline.sharpe) * 100;
    const dDdPctVL = baseline.max_dd_r === 0 ? 0 : ((vl.max_dd_r - baseline.max_dd_r) / baseline.max_dd_r) * 100;

    const passesVH = dSharpePctVH >= SHARPE_PCT_GATE || dDdPctVH <= -DD_PCT_CUT_GATE;
    const passesVL = dSharpePctVL >= SHARPE_PCT_GATE || dDdPctVL <= -DD_PCT_CUT_GATE;

    perFeature.push({
      feature: name,
      rank_by_h3_gain: r + 1,
      median_value: med,
      veto_high: { metrics: vh, delta_sharpe_pct: dSharpePctVH, delta_dd_pct: dDdPctVH, passes: passesVH },
      veto_low: { metrics: vl, delta_sharpe_pct: dSharpePctVL, delta_dd_pct: dDdPctVL, passes: passesVL },
    });

    const markVH = passesVH ? "✓" : "✗";
    const markVL = passesVL ? "✓" : "✗";
    console.log(
      `  ${name.padEnd(35)} | VH: ΔS ${dSharpePctVH.toFixed(1).padStart(6)}% ΔDD ${dDdPctVH.toFixed(1).padStart(6)}% ${markVH} | VL: ΔS ${dSharpePctVL.toFixed(1).padStart(6)}% ΔDD ${dDdPctVL.toFixed(1).padStart(6)}% ${markVL}`,
    );
  }

  const passesAny = perFeature.some(
    (f) => (f.veto_high && f.veto_high.passes) || (f.veto_low && f.veto_low.passes),
  );
  const verdict: "PASS" | "FAIL" = passesAny ? "PASS" : "FAIL";
  const passingFeatures = perFeature
    .filter((f) => (f.veto_high && f.veto_high.passes) || (f.veto_low && f.veto_low.passes))
    .map((f) => f.feature);

  console.log("");
  console.log(`H.4-METHODOLOGY-REVISION VERDICT: ${verdict}`);
  if (verdict === "PASS") {
    console.log(`  Passing features (${passingFeatures.length}/${perFeature.length}):`);
    for (const f of passingFeatures) console.log(`    ✓ ${f}`);
    console.log("");
    console.log("  Next step: wire winning feature(s) into v3 survivor's rules as entry filter,");
    console.log("  then re-run validate-algo → F → F2 to confirm augmented variant still passes.");
  } else {
    console.log(`  No feature improves Sharpe by ≥${SHARPE_PCT_GATE}% OR cuts max-DD by ≥${DD_PCT_CUT_GATE}%.`);
    console.log("  v3 survivor cannot be salvaged via feature-veto framing.");
    console.log("  Per H.4-methodology-revision dispatcher: this gate FAILS → H.4b blocked for this algo.");
    console.log("  Forward: Phase E2 re-search (operator-approved) is the next-best action.");
  }

  if (PERSIST) {
    const output = {
      gate: "H.4-methodology-revision (feature-as-filter)" as const,
      algo_id: ALGO_ID,
      algo_name: algo.name,
      algo_class: algoClass,
      verdict,
      sharpe_pct_gate: SHARPE_PCT_GATE,
      dd_pct_cut_gate: DD_PCT_CUT_GATE,
      top_k: TOP_K,
      baseline,
      passing_features: passingFeatures,
      per_feature: perFeature,
      generated_at: new Date().toISOString(),
    };
    writeFileSync(OUTPUT_JSON, JSON.stringify(output, null, 2));
    console.log("");
    console.log(`Persisted ${OUTPUT_JSON}`);
  }
}

main().catch((err) => {
  console.error("[feature-veto-validate] unhandled error:", err);
  process.exit(1);
});
