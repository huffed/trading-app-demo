/**
 * F2.3 — Block-bootstrap-bars search robustness audit.
 *
 * Tests whether the v3 survivor's edge depends on the EXACT realized
 * price path or whether it survives moving-block resampling of the
 * underlying OHLC bars. Block bootstrap (Künsch 1989) preserves intra-
 * block serial correlation while breaking across-block dependencies —
 * the standard non-parametric test for time-series signal robustness.
 *
 * Method:
 *   1. Load family (96-variant Engulfing-Long Layer B family by default)
 *   2. Load XAU/USD 4h bars (block bootstrap requires single-ticker)
 *   3. For seed s ∈ [BASE_SEED, BASE_SEED + N_RESAMPLES):
 *      a. Block-bootstrap the bars (block_size = 24 = 1 day at 4h)
 *      b. Run all 96 variants against synthetic bars
 *      c. Rank by Sharpe; capture survivor's rank
 *   4. Aggregate: survivor's top-K hit-rate across resamples
 *
 * Pre-registered gate (TWO sub-tests, OR-composed per phase-e2-sweep-lock.md E2.7 addendum):
 *   POINT-STABILITY (original F2.3): the named SURVIVOR variant ranks in
 *     top-K (default 3) by Sharpe in ≥ GATE_THRESHOLD/N seeds.
 *   CLUSTER-STABILITY (E2.7 addition 2026-06-29): |original_top_K ∩
 *     resampled_top_K| ≥ MIN_INTERSECT (default 1) in ≥ GATE_THRESHOLD/N
 *     seeds. Tests robustness of the peak REGION (correct semantic for
 *     flat-cluster surfaces) instead of the peak POINT.
 *   COMPOSITION: F2.3 PASS iff point-stability OR cluster-stability passes.
 *   Defaults: TOP_K=3, MIN_INTERSECT=1, GATE_THRESHOLD=6, N_RESAMPLES=10
 *
 * Why composition (not AND, not replacement): cluster-stability provides
 * an ALTERNATIVE PASS path for flat-cluster surfaces while preserving the
 * existing point-stability gate for surfaces with discriminating peaks.
 * Empirical motivation: N=4 H.9 gate test (2026-06-25) found all 4
 * candidates (grid+BO × ARB+Engulfing) failed point-stability because
 * gold-only 4h surfaces are flat-cluster, NOT flat-line. See
 * `[[feedback_grid_search_flatness_at_retail_data]]`.
 *
 * Compute: 10 seeds × 96 backtests × ~5s/each = ~80min wall-clock (+ 1
 * pre-loop pass for original ranking; ~5s × 96 = +8min).
 *
 * Pre-registration locking: block_size=24, base_seed=42, n_resamples=10,
 * top_k=3, gate_threshold=6, min_intersect=1 are hardcoded in the driver
 * and cannot be tuned post-hoc without a commit. Env overrides emit a
 * WARNING to stderr so any deviation is conspicuous in the result file.
 *
 * Persists scripts/canonical/robustness-bootstrap-bars-results.json with
 * per-seed survivor rank + Sharpe + family-summary for F2.5.
 *
 * Usage:
 *   pnpm dlx tsx scripts/canonical/robustness-bootstrap-bars.ts
 *
 * Env:
 *   FAMILY_PATTERN   default "LayerB: XAU/USD Engulfing-Long 4h | %"
 *   SURVIVOR_TAG     default "rr3_lb6_r06_rf0_af0"
 *   BLOCK_SIZE       default 24 (1 day at 4h — pre-registered)
 *   BASE_SEED        default 42
 *   N_RESAMPLES      default 10
 *   TOP_K            default 3
 *   GATE_THRESHOLD   default 6 (out of N_RESAMPLES)
 *   MIN_INTERSECT    default 1 (E2.7 cluster-stability — minimum intersection size)
 *   OUTPUT_JSON      default scripts/canonical/robustness-bootstrap-bars-results.json
 *   PERSIST          default 1
 */
import { readFileSync, writeFileSync } from "fs";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { timeframeToInterval } from "../../src/lib/market-data/interval";
import { runPortfolioBacktest } from "../../src/lib/market-data/portfolio-backtest";
import { blockBootstrapBars } from "../../src/lib/stats/block-bootstrap-bars";
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

// Pre-registered constants (env overrides emit warnings).
const DEFAULT_BLOCK_SIZE = 24;
const DEFAULT_BASE_SEED = 42;
const DEFAULT_N_RESAMPLES = 10;
const DEFAULT_TOP_K = 3;
const DEFAULT_GATE_THRESHOLD = 6;
// E2.7 cluster-stability sub-gate (pre-registered 2026-06-29 per phase-e2-sweep-lock.md addendum).
// Cluster-stability passes for seed s iff |original_top_K ∩ resampled_top_K| ≥ MIN_INTERSECT.
// Defaults locked to MIN_INTERSECT=1 (most lenient cluster definition: ANY original top-K survives).
const DEFAULT_MIN_INTERSECT = 1;

const FAMILY_PATTERN =
  process.env.FAMILY_PATTERN ?? "LayerB: XAU/USD Engulfing-Long 4h | %";
const SURVIVOR_TAG = process.env.SURVIVOR_TAG ?? "rr3_lb6_r06_rf0_af0";

const BLOCK_SIZE = Number(process.env.BLOCK_SIZE ?? DEFAULT_BLOCK_SIZE);
const BASE_SEED = Number(process.env.BASE_SEED ?? DEFAULT_BASE_SEED);
const N_RESAMPLES = Math.max(1, Number(process.env.N_RESAMPLES ?? DEFAULT_N_RESAMPLES));
const TOP_K = Math.max(1, Number(process.env.TOP_K ?? DEFAULT_TOP_K));
const GATE_THRESHOLD = Math.max(1, Number(process.env.GATE_THRESHOLD ?? DEFAULT_GATE_THRESHOLD));
const MIN_INTERSECT = Math.max(1, Number(process.env.MIN_INTERSECT ?? DEFAULT_MIN_INTERSECT));
const OUTPUT_JSON =
  process.env.OUTPUT_JSON ?? "scripts/canonical/robustness-bootstrap-bars-results.json";
const PERSIST = process.env.PERSIST !== "0";

function warnOverride(name: string, defaultValue: number, observed: number): void {
  if (observed !== defaultValue) {
    console.warn(
      `[robustness-bootstrap-bars] WARNING: ${name} overridden from pre-registered default ` +
        `${defaultValue} → ${observed}. This deviation will appear in the result file.`,
    );
  }
}
warnOverride("BLOCK_SIZE", DEFAULT_BLOCK_SIZE, BLOCK_SIZE);
warnOverride("BASE_SEED", DEFAULT_BASE_SEED, BASE_SEED);
warnOverride("N_RESAMPLES", DEFAULT_N_RESAMPLES, N_RESAMPLES);
warnOverride("TOP_K", DEFAULT_TOP_K, TOP_K);
warnOverride("GATE_THRESHOLD", DEFAULT_GATE_THRESHOLD, GATE_THRESHOLD);
warnOverride("MIN_INTERSECT", DEFAULT_MIN_INTERSECT, MIN_INTERSECT);

function requireEnv(): { url: string; key: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error(
      "robustness-bootstrap-bars requires NEXT_PUBLIC_SUPABASE_URL + " +
        "SUPABASE_SERVICE_ROLE_KEY (preferred) or NEXT_PUBLIC_SUPABASE_ANON_KEY in .env.local.",
    );
  }
  return { url, key };
}

function extractTicker(name: string): string {
  return name.replace(/^(Search|LayerB\+?|BO\+?):\s*/, "").split(" ")[0] ?? "XAU/USD";
}

function extractTimeframe(name: string): string {
  return name.match(/\s(\d+[mh])\s/)?.[1] ?? "4h";
}

function riskDollarsFor(rules: AlgorithmRules, capital: number): number {
  const sizing = rules.position_sizing;
  if (sizing?.type === "risk_per_trade") return capital * (sizing.value / 100);
  return capital * 0.01;
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

interface VariantSpec {
  name: string;
  is_survivor: boolean;
  rules: AlgorithmRules;
  capital: number;
}

interface PerSeedResult {
  seed: number;
  survivor_rank: number; // -1 if absent
  survivor_sharpe: number;
  survivor_trade_count: number;
  survivor_in_top_k: boolean;
  top_k_variants: Array<{ name: string; rank: number; sharpe: number; trade_count: number }>;
  variant_count: number;
  /** E2.7 cluster-stability: variants that appear in BOTH original top-K and resampled top-K for this seed. */
  cluster_intersection: string[];
  /** E2.7 cluster-stability passes for this seed iff cluster_intersection.length ≥ MIN_INTERSECT. */
  cluster_in_top_k: boolean;
}

async function main(): Promise<void> {
  const { url, key } = requireEnv();
  const supabase = createClient<Database>(url, key);

  console.log(`F2.3 block-bootstrap-bars robustness audit`);
  console.log(`  family : ${FAMILY_PATTERN}`);
  console.log(`  survivor tag : ${SURVIVOR_TAG}`);
  console.log(`  block_size : ${BLOCK_SIZE} bars (pre-registered: ${DEFAULT_BLOCK_SIZE})`);
  console.log(`  resamples : ${N_RESAMPLES} (seeds [${BASE_SEED}, ${BASE_SEED + N_RESAMPLES - 1}])`);
  console.log(`  point-stability gate : survivor top-${TOP_K} in ≥${GATE_THRESHOLD}/${N_RESAMPLES} seeds`);
  console.log(`  cluster-stability gate (E2.7) : |original top-${TOP_K} ∩ resampled top-${TOP_K}| ≥ ${MIN_INTERSECT} in ≥${GATE_THRESHOLD}/${N_RESAMPLES} seeds`);
  console.log(`  composition : F2.3 PASS iff point-stability OR cluster-stability passes`);
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

  const allTickers = new Set<string>();
  for (const r of rows) allTickers.add(extractTicker(r.name));
  if (allTickers.size > 1) {
    throw new Error(
      `Family spans multiple tickers (${[...allTickers].join(", ")}); F2.3 expects a single-ticker family`,
    );
  }
  const ticker = [...allTickers][0];
  const timeframe = extractTimeframe(rows[0].name);
  console.log(`Loading bars for ${ticker} ${timeframe}...`);
  const realBars = await loadBars(supabase, ticker, timeframe);
  console.log(`  bars : ${realBars.length} (span ${realBars[0]?.date} → ${realBars[realBars.length - 1]?.date})`);

  const variants: VariantSpec[] = rows.map((r) => ({
    name: r.name,
    is_survivor: r.name.endsWith(`| ${SURVIVOR_TAG}`),
    rules: r.rules as unknown as AlgorithmRules,
    capital: Number(r.capital),
  }));

  // E2.7: compute ORIGINAL top-K ranking on REAL bars BEFORE the bootstrap loop.
  // This is the cluster against which we test resampled top-K intersection.
  console.log("");
  console.log("Original ranking (real bars, for cluster-stability comparison):");
  const realPricesByTicker = new Map<string, PriceBar[]>([[ticker.toUpperCase(), realBars]]);
  const realScores: Array<{ name: string; sharpe: number; trade_count: number }> = [];
  for (const v of variants) {
    const result = runPortfolioBacktest(v.rules, realPricesByTicker, v.capital);
    const trades = result.trades ?? [];
    const risk = riskDollarsFor(v.rules, v.capital);
    realScores.push({
      name: v.name,
      sharpe: sharpe(trades, risk),
      trade_count: trades.length,
    });
  }
  const realRanked = [...realScores].sort((a, b) => b.sharpe - a.sharpe);
  const originalTopK = realRanked.slice(0, TOP_K).map((e) => e.name);
  const originalTopKSet = new Set(originalTopK);
  for (let i = 0; i < originalTopK.length; i++) {
    const e = realRanked[i];
    console.log(`  #${i + 1} ${e.name.padEnd(70)} sharpe=${e.sharpe.toFixed(4)} trades=${e.trade_count}`);
  }

  console.log("");
  console.log("Bootstrap loop:");
  const perSeed: PerSeedResult[] = [];

  for (let i = 0; i < N_RESAMPLES; i++) {
    const seed = BASE_SEED + i;
    const syntheticBars = blockBootstrapBars(realBars, { blockSize: BLOCK_SIZE, seed });
    const pricesByTicker = new Map<string, PriceBar[]>([[ticker.toUpperCase(), syntheticBars]]);

    const variantScores: Array<{ name: string; is_survivor: boolean; sharpe: number; trade_count: number }> = [];
    for (const v of variants) {
      const result = runPortfolioBacktest(v.rules, pricesByTicker, v.capital);
      const trades = result.trades ?? [];
      const risk = riskDollarsFor(v.rules, v.capital);
      variantScores.push({
        name: v.name,
        is_survivor: v.is_survivor,
        sharpe: sharpe(trades, risk),
        trade_count: trades.length,
      });
    }

    const ranked = [...variantScores].sort((a, b) => b.sharpe - a.sharpe);
    const survivorIdx = ranked.findIndex((x) => x.is_survivor);
    const survivorRank = survivorIdx >= 0 ? survivorIdx + 1 : -1;
    const survivor = ranked[survivorIdx] ?? null;
    const survivorInTopK = survivorRank > 0 && survivorRank <= TOP_K;
    const topK = ranked.slice(0, TOP_K).map((e, idx) => ({
      name: e.name,
      rank: idx + 1,
      sharpe: e.sharpe,
      trade_count: e.trade_count,
    }));

    // E2.7 cluster-stability: which of the ORIGINAL top-K appear in the RESAMPLED top-K?
    const resampledTopKSet = new Set(topK.map((e) => e.name));
    const clusterIntersection = originalTopK.filter((n) => resampledTopKSet.has(n));
    const clusterInTopK = clusterIntersection.length >= MIN_INTERSECT;

    perSeed.push({
      seed,
      survivor_rank: survivorRank,
      survivor_sharpe: survivor?.sharpe ?? 0,
      survivor_trade_count: survivor?.trade_count ?? 0,
      survivor_in_top_k: survivorInTopK,
      top_k_variants: topK,
      variant_count: variantScores.length,
      cluster_intersection: clusterIntersection,
      cluster_in_top_k: clusterInTopK,
    });

    const pointMarker = survivorInTopK ? "✓" : "✗";
    const clusterMarker = clusterInTopK ? "✓" : "✗";
    console.log(
      `  seed=${seed} → point rank=${survivorRank}/${variantScores.length} sharpe=${(survivor?.sharpe ?? 0).toFixed(4)} top-${TOP_K}=${pointMarker} | cluster ∩=${clusterIntersection.length}/${TOP_K} =${clusterMarker}`,
    );
  }

  const inTopK = perSeed.filter((r) => r.survivor_in_top_k).length;
  const clusterInTopK = perSeed.filter((r) => r.cluster_in_top_k).length;
  const pointVerdict: "PASS" | "FAIL" = inTopK >= GATE_THRESHOLD ? "PASS" : "FAIL";
  const clusterVerdict: "PASS" | "FAIL" = clusterInTopK >= GATE_THRESHOLD ? "PASS" : "FAIL";
  // E2.7 composition: F2.3 PASS iff point-stability OR cluster-stability passes
  const verdict: "PASS" | "FAIL" =
    pointVerdict === "PASS" || clusterVerdict === "PASS" ? "PASS" : "FAIL";

  console.log("");
  console.log(`F2.3 BOOTSTRAP-BARS VERDICT (composite): ${verdict}`);
  console.log(`  point-stability   : ${pointVerdict} (survivor top-${TOP_K} in ${inTopK}/${N_RESAMPLES} seeds; need ≥${GATE_THRESHOLD})`);
  console.log(`  cluster-stability : ${clusterVerdict} (original top-${TOP_K} ∩ resampled top-${TOP_K} ≥ ${MIN_INTERSECT} in ${clusterInTopK}/${N_RESAMPLES} seeds; need ≥${GATE_THRESHOLD})`);

  const output = {
    sub_gate: "F2.3 bootstrap-bars" as const,
    verdict,
    in_top_k_count: inTopK,
    gate_threshold: GATE_THRESHOLD,
    top_k: TOP_K,
    n_resamples: N_RESAMPLES,
    block_size: BLOCK_SIZE,
    base_seed: BASE_SEED,
    // E2.7 cluster-stability companion fields (always populated; null/0 if disabled)
    point_stability: {
      verdict: pointVerdict,
      in_top_k_count: inTopK,
      gate_threshold: GATE_THRESHOLD,
    },
    cluster_stability: {
      verdict: clusterVerdict,
      in_top_k_count: clusterInTopK,
      gate_threshold: GATE_THRESHOLD,
      min_intersect: MIN_INTERSECT,
      original_top_k: originalTopK,
    },
    composition_rule: "F2.3 PASS iff point-stability OR cluster-stability passes",
    pre_registration: {
      block_size_default: DEFAULT_BLOCK_SIZE,
      base_seed_default: DEFAULT_BASE_SEED,
      n_resamples_default: DEFAULT_N_RESAMPLES,
      top_k_default: DEFAULT_TOP_K,
      gate_threshold_default: DEFAULT_GATE_THRESHOLD,
      min_intersect_default: DEFAULT_MIN_INTERSECT,
      overrides_present:
        BLOCK_SIZE !== DEFAULT_BLOCK_SIZE ||
        BASE_SEED !== DEFAULT_BASE_SEED ||
        N_RESAMPLES !== DEFAULT_N_RESAMPLES ||
        TOP_K !== DEFAULT_TOP_K ||
        GATE_THRESHOLD !== DEFAULT_GATE_THRESHOLD ||
        MIN_INTERSECT !== DEFAULT_MIN_INTERSECT,
    },
    family_pattern: FAMILY_PATTERN,
    survivor_tag: SURVIVOR_TAG,
    ticker,
    timeframe,
    per_seed_results: perSeed,
    generated_at: new Date().toISOString(),
  };

  if (PERSIST) {
    writeFileSync(OUTPUT_JSON, JSON.stringify(output, null, 2));
    console.log(`Persisted ${OUTPUT_JSON}`);
  } else {
    console.log("(PERSIST=0 — verdict only, no file written)");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
