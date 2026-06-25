/**
 * F2.1 — Multi-cut OOS search robustness audit.
 *
 * Re-evaluates the v3 survivor's pass/rank status under 4 different OOS
 * cutoff dates. Tests whether the survivor's edge depends on the exact
 * OOS-cut date (current canonical default = 2025-06-18).
 *
 * Method:
 *   1. Load family (96-variant Engulfing-Long Layer B family by default)
 *   2. Backtest each variant ONCE (against full price history)
 *   3. For each cut date:
 *      a. Partition each variant's trades into in-sample (entry_date < cut)
 *         and OOS (entry_date >= cut)
 *      b. Recompute oos_r_delta_pct + held_out_n per variant
 *      c. Re-evaluate per-candidate criteria (1-7) per variant
 *      d. Rank variants by Sharpe (descending)
 *      e. Check: survivor passes per-candidate? survivor in top-K by Sharpe?
 *
 * Pre-registered gate:
 *   PASS iff:
 *     (a) survivor passes per-candidate in ≥3/4 cuts, AND
 *     (b) survivor ranks top-K (default 3) by Sharpe in ≥2/4 cuts
 *
 * Compute: ~96 backtests × ~5s/each = ~8min wall-clock (4 cuts share the
 * same backtest results — only the partition logic re-runs per cut).
 *
 * Persists scripts/canonical/robustness-multi-cut-results.json with full
 * per-cut per-variant evaluation for F2.5.
 *
 * Usage:
 *   pnpm dlx tsx scripts/canonical/robustness-multi-cut.ts
 *
 * Env:
 *   FAMILY_PATTERN     default "LayerB: XAU/USD Engulfing-Long 4h | %"
 *   SURVIVOR_TAG       default "rr3_lb6_r06_rf0_af0"
 *   CUT_DATES          default "2024-09-01,2024-12-01,2025-03-01,2025-06-01" (CSV ISO dates)
 *   TOP_K              default 3
 *   PER_CAND_THRESHOLD default 3 (out of len(CUT_DATES))
 *   RANK_THRESHOLD     default 2 (out of len(CUT_DATES))
 *   OUTPUT_JSON        default scripts/canonical/robustness-multi-cut-results.json
 *   PERSIST            default 1
 */
import { readFileSync, writeFileSync } from "fs";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { timeframeToInterval } from "../../src/lib/market-data/interval";
import { runPortfolioBacktest } from "../../src/lib/market-data/portfolio-backtest";
import { bootstrapStat, bootstrapStatBlock } from "../../src/lib/stats/bootstrap";
import type { Database } from "../../src/lib/supabase/database.types";
import type { BacktestTrade, PriceBar } from "../../src/lib/market-data/types";
import type { AlgorithmRules } from "../../src/types/algorithm";

// .env.local loader
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

const FAMILY_PATTERN =
  process.env.FAMILY_PATTERN ?? "LayerB: XAU/USD Engulfing-Long 4h | %";
const SURVIVOR_TAG = process.env.SURVIVOR_TAG ?? "rr3_lb6_r06_rf0_af0";
const CUT_DATES = (process.env.CUT_DATES ?? "2024-09-01,2024-12-01,2025-03-01,2025-06-01")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const TOP_K = Math.max(1, Number(process.env.TOP_K ?? 3));
const PER_CAND_THRESHOLD = Math.max(1, Number(process.env.PER_CAND_THRESHOLD ?? 3));
const RANK_THRESHOLD = Math.max(1, Number(process.env.RANK_THRESHOLD ?? 2));
const OUTPUT_JSON =
  process.env.OUTPUT_JSON ?? "scripts/canonical/robustness-multi-cut-results.json";
const PERSIST = process.env.PERSIST !== "0";
const BOOTSTRAP_ITERATIONS = Number(process.env.BOOTSTRAP_ITERATIONS ?? 2000);
const BOOTSTRAP_SEED = Number(process.env.BOOTSTRAP_SEED ?? 42);
const ENABLE_BLOCK_BOOTSTRAP = process.env.BLOCK_BOOTSTRAP !== "0";

function requireEnv(): { url: string; key: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error(
      "robustness-multi-cut requires NEXT_PUBLIC_SUPABASE_URL + " +
        "SUPABASE_SERVICE_ROLE_KEY (preferred) or NEXT_PUBLIC_SUPABASE_ANON_KEY in .env.local.",
    );
  }
  return { url, key };
}

function extractTicker(name: string): string {
  const noPrefix = name.replace(/^(Search|LayerB\+?|BO\+?):\s*/, "");
  const tokens = noPrefix.split(" ");
  return tokens[0] ?? "XAU/USD";
}

function extractTimeframe(name: string): string {
  const match = name.match(/\s(\d+[mh])\s/);
  return match?.[1] ?? "4h";
}

function riskDollarsFor(rules: AlgorithmRules, capital: number): number {
  const sizing = rules.position_sizing;
  if (sizing?.type === "risk_per_trade") return capital * (sizing.value / 100);
  return capital * 0.01;
}

interface VariantBacktest {
  name: string;
  is_survivor: boolean;
  rules: AlgorithmRules;
  capital: number;
  trades: BacktestTrade[];
  risk_dollars: number;
  total_return: number;
  max_static_dd_pct: number;
  max_daily_dd_pct: number;
}

interface PerCutVariantEvaluation {
  name: string;
  is_survivor: boolean;
  in_sample_n: number;
  oos_n: number;
  in_sample_mean_r: number;
  oos_mean_r: number;
  oos_r_delta_pct: number;
  /** Sharpe over IN-SAMPLE trades only (matches Layer A canonical Sharpe). */
  in_sample_sharpe: number;
  /** Bootstrapped mean-R 95% CI lower bound on IN-SAMPLE trades. */
  mean_r_ci_lower: number;
  per_candidate_passes: boolean;
  per_candidate_blockers: string[];
}

interface PerCutResult {
  cut_date: string;
  survivor_passes_per_candidate: boolean;
  survivor_rank_by_sharpe: number; // -1 if missing
  survivor_in_top_k: boolean;
  top_k_variants: Array<{ name: string; rank: number; sharpe: number }>;
  variant_evaluations: PerCutVariantEvaluation[];
}

function partitionByCut(
  trades: readonly BacktestTrade[],
  cutISO: string,
): { in_sample: BacktestTrade[]; oos: BacktestTrade[] } {
  const cutMs = new Date(cutISO).getTime();
  const in_sample: BacktestTrade[] = [];
  const oos: BacktestTrade[] = [];
  for (const t of trades) {
    const entryMs = new Date(t.entry_date).getTime();
    if (entryMs < cutMs) in_sample.push(t);
    else oos.push(t);
  }
  return { in_sample, oos };
}

function meanR(trades: readonly BacktestTrade[], risk: number): number {
  if (trades.length === 0 || risk <= 0) return 0;
  let sum = 0;
  for (const t of trades) sum += t.pnl / risk;
  return sum / trades.length;
}

function sharpe(trades: readonly BacktestTrade[], risk: number): number {
  if (trades.length < 2 || risk <= 0) return 0;
  const r = trades.map((t) => t.pnl / risk);
  const m = r.reduce((a, b) => a + b, 0) / r.length;
  let var_ = 0;
  for (const x of r) var_ += (x - m) ** 2;
  const std = Math.sqrt(var_ / r.length);
  return std === 0 ? 0 : m / std;
}

function evaluatePerCandidate(
  total_return: number,
  max_static_dd_pct: number,
  max_daily_dd_pct: number,
  in_sample_n: number,
  oos_n: number,
  oos_r_delta_pct: number,
  mean_r_ci_lower: number,
): { passes: boolean; blockers: string[] } {
  const blockers: string[] = [];
  if (!(total_return > 0)) blockers.push(`total_return ${total_return.toFixed(2)} ≤ 0`);
  if (!(max_static_dd_pct <= 10)) blockers.push(`static_dd ${max_static_dd_pct.toFixed(2)}% > 10%`);
  if (!(max_daily_dd_pct <= 5)) blockers.push(`daily_dd ${max_daily_dd_pct.toFixed(2)}% > 5%`);
  if (!(in_sample_n >= 30)) blockers.push(`in_sample_n ${in_sample_n} < 30`);
  if (!(mean_r_ci_lower > 0)) blockers.push(`mean_r_ci_lower ${mean_r_ci_lower.toFixed(4)} ≤ 0`);
  if (!(oos_n >= 10)) blockers.push(`oos_n ${oos_n} < 10`);
  if (!(Math.abs(oos_r_delta_pct) <= 50)) blockers.push(`|oos_r_delta| ${Math.abs(oos_r_delta_pct).toFixed(1)}% > 50%`);
  return { passes: blockers.length === 0, blockers };
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
  if (error || !data) {
    throw new Error(`No cached bars for ${ticker} ${interval}: ${error?.message ?? "row missing"}`);
  }
  return data.bars as unknown as PriceBar[];
}

async function main(): Promise<void> {
  const { url, key } = requireEnv();
  const supabase = createClient<Database>(url, key);

  console.log(`F2.1 multi-cut OOS robustness audit`);
  console.log(`  family : ${FAMILY_PATTERN}`);
  console.log(`  survivor tag : ${SURVIVOR_TAG}`);
  console.log(`  cut dates : ${CUT_DATES.join(", ")}`);
  console.log(`  per-cand threshold : ≥${PER_CAND_THRESHOLD}/${CUT_DATES.length} cuts`);
  console.log(`  rank threshold (top-${TOP_K}) : ≥${RANK_THRESHOLD}/${CUT_DATES.length} cuts`);
  console.log(`  block bootstrap : ${ENABLE_BLOCK_BOOTSTRAP ? "on" : "off"}`);
  console.log("");

  const { data: rows, error } = await supabase
    .from("algorithms")
    .select("id, name, rules, capital")
    .like("name", FAMILY_PATTERN);
  if (error) throw new Error(`Failed to fetch family: ${error.message}`);
  if (!rows || rows.length === 0) {
    throw new Error(`No rows match family pattern '${FAMILY_PATTERN}'`);
  }
  console.log(`Loaded ${rows.length} family variants`);

  // Backtest every variant ONCE — all cuts re-use these trades.
  const allTickers = new Set<string>();
  for (const r of rows) allTickers.add(extractTicker(r.name));
  if (allTickers.size > 1) {
    throw new Error(
      `Family spans multiple tickers (${[...allTickers].join(", ")}); F2.1 expects a single-ticker family`,
    );
  }
  const ticker = [...allTickers][0];
  const timeframe = extractTimeframe(rows[0].name);
  console.log(`Loading bars for ${ticker} ${timeframe}...`);
  const bars = await loadBars(supabase, ticker, timeframe);
  const pricesByTicker = new Map<string, PriceBar[]>([[ticker.toUpperCase(), bars]]);

  console.log("Running backtests on all variants (single pass)...");
  const variants: VariantBacktest[] = [];
  let processed = 0;
  for (const r of rows) {
    processed++;
    const rules = r.rules as unknown as AlgorithmRules;
    const capital = Number(r.capital);
    const result = runPortfolioBacktest(rules, pricesByTicker, capital);
    const propReport = result.prop_firm_report;
    // PropFirmReport: peak_drawdown + max_daily_loss are DOLLARS (per types.ts).
    // Backtest's max_drawdown is also dollars. Convert to pct via /capital × 100.
    // Fallbacks: prop_firm_report absent → compute from BacktestMetrics.max_drawdown.
    const peakDdDollars = propReport?.peak_drawdown ?? Math.abs(result.max_drawdown ?? 0);
    const dailyLossDollars = propReport?.max_daily_loss ?? 0;
    variants.push({
      name: r.name,
      is_survivor: r.name.endsWith(`| ${SURVIVOR_TAG}`),
      rules,
      capital,
      trades: result.trades ?? [],
      risk_dollars: riskDollarsFor(rules, capital),
      total_return: result.total_return,
      max_static_dd_pct: capital > 0 ? (peakDdDollars / capital) * 100 : 0,
      max_daily_dd_pct: capital > 0 ? (dailyLossDollars / capital) * 100 : 0,
    });
    if (processed % 16 === 0 || processed === rows.length) {
      console.log(`  backtest progress : ${processed}/${rows.length}`);
    }
  }

  console.log("");
  console.log("Evaluating per-cut:");
  const perCutResults: PerCutResult[] = [];
  for (const cut of CUT_DATES) {
    const evaluations: PerCutVariantEvaluation[] = [];

    for (const v of variants) {
      const { in_sample, oos } = partitionByCut(v.trades, cut);
      const in_mean = meanR(in_sample, v.risk_dollars);
      const oos_mean = meanR(oos, v.risk_dollars);
      const delta_pct = in_mean === 0 ? 0 : ((oos_mean - in_mean) / Math.abs(in_mean)) * 100;
      const in_sharpe = sharpe(in_sample, v.risk_dollars);

      // Bootstrap mean R CI lower bound — block bootstrap default ON.
      let ciLower = 0;
      if (in_sample.length >= 2) {
        const meanRFn = (sample: BacktestTrade[]): number => meanR(sample, v.risk_dollars);
        const ci = ENABLE_BLOCK_BOOTSTRAP
          ? bootstrapStatBlock<BacktestTrade>(in_sample, meanRFn, {
              n_iterations: BOOTSTRAP_ITERATIONS,
              seed: BOOTSTRAP_SEED,
            })
          : bootstrapStat<BacktestTrade>(in_sample, meanRFn, {
              n_iterations: BOOTSTRAP_ITERATIONS,
              seed: BOOTSTRAP_SEED,
            });
        ciLower = ci.lower;
      }

      const candEval = evaluatePerCandidate(
        v.total_return,
        v.max_static_dd_pct,
        v.max_daily_dd_pct,
        in_sample.length,
        oos.length,
        delta_pct,
        ciLower,
      );

      evaluations.push({
        name: v.name,
        is_survivor: v.is_survivor,
        in_sample_n: in_sample.length,
        oos_n: oos.length,
        in_sample_mean_r: in_mean,
        oos_mean_r: oos_mean,
        oos_r_delta_pct: delta_pct,
        in_sample_sharpe: in_sharpe,
        mean_r_ci_lower: ciLower,
        per_candidate_passes: candEval.passes,
        per_candidate_blockers: candEval.blockers,
      });
    }

    // Rank by in-sample Sharpe descending; ties broken by mean R lower CI.
    const ranked = [...evaluations].sort((a, b) => {
      if (a.in_sample_sharpe === b.in_sample_sharpe) return b.mean_r_ci_lower - a.mean_r_ci_lower;
      return b.in_sample_sharpe - a.in_sample_sharpe;
    });

    const survivorIdx = ranked.findIndex((e) => e.is_survivor);
    const survivorRank = survivorIdx >= 0 ? survivorIdx + 1 : -1;
    const survivorPasses = ranked[survivorIdx]?.per_candidate_passes ?? false;
    const survivorInTopK = survivorRank > 0 && survivorRank <= TOP_K;

    const topK = ranked.slice(0, TOP_K).map((e, i) => ({
      name: e.name,
      rank: i + 1,
      sharpe: e.in_sample_sharpe,
    }));

    perCutResults.push({
      cut_date: cut,
      survivor_passes_per_candidate: survivorPasses,
      survivor_rank_by_sharpe: survivorRank,
      survivor_in_top_k: survivorInTopK,
      top_k_variants: topK,
      variant_evaluations: evaluations,
    });

    const passMarker = survivorPasses ? "✓" : "✗";
    const rankMarker = survivorInTopK ? "✓" : "✗";
    console.log(
      `  cut=${cut} → survivor pass=${passMarker} rank=${survivorRank}/${variants.length} top-${TOP_K}=${rankMarker}`,
    );
  }

  const perCandPasses = perCutResults.filter((r) => r.survivor_passes_per_candidate).length;
  const rankPasses = perCutResults.filter((r) => r.survivor_in_top_k).length;
  const perCandGate = perCandPasses >= PER_CAND_THRESHOLD;
  const rankGate = rankPasses >= RANK_THRESHOLD;
  const verdict: "PASS" | "FAIL" = perCandGate && rankGate ? "PASS" : "FAIL";

  console.log("");
  console.log(`F2.1 MULTI-CUT OOS VERDICT: ${verdict}`);
  console.log(`  per-candidate gate : ${perCandPasses}/${CUT_DATES.length} cuts pass (need ≥${PER_CAND_THRESHOLD}) ${perCandGate ? "✓" : "✗"}`);
  console.log(`  rank gate (top-${TOP_K}) : ${rankPasses}/${CUT_DATES.length} cuts pass (need ≥${RANK_THRESHOLD}) ${rankGate ? "✓" : "✗"}`);

  const output = {
    sub_gate: "F2.1 multi-cut-oos" as const,
    verdict,
    per_candidate_pass_count: perCandPasses,
    per_candidate_threshold: PER_CAND_THRESHOLD,
    rank_pass_count: rankPasses,
    rank_threshold: RANK_THRESHOLD,
    top_k: TOP_K,
    cut_dates: CUT_DATES,
    family_pattern: FAMILY_PATTERN,
    survivor_tag: SURVIVOR_TAG,
    per_cut_results: perCutResults,
    generated_at: new Date().toISOString(),
  };

  if (PERSIST) {
    writeFileSync(OUTPUT_JSON, JSON.stringify(output, null, 2));
    console.log("");
    console.log(`Persisted ${OUTPUT_JSON}`);
  } else {
    console.log("");
    console.log("(PERSIST=0 — verdict only, no file written)");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
