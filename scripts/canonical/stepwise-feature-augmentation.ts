/**
 * H.4b proper — Stepwise feature augmentation driver.
 *
 * Greedy forward selection over top-K pattern features for a single
 * candidate algo. At each step, tries adding each remaining pattern
 * feature as an additional PatternCondition in entry_conditions
 * (entry_logic="all"), keeps the SINGLE feature that most improves
 * Sharpe (subject to gate), repeats up to MAX_FEATURES times or until
 * no remaining feature improves enough.
 *
 * Methodology (operator-clarified 2026-06-24, per
 * [[feedback_no_presupposed_features]]):
 *   - Features are DISCOVERED axes, never required base conditions
 *   - Greedy stepwise selection O(K²/2) backtests vs 2^K full grid
 *   - Selection bias DSR/PBO deflation runs separately via
 *     `run-augmented-f-f2.sh` AFTER this driver picks a winning
 *     augmentation — this driver is a HYPOTHESIS GENERATOR, not a
 *     ship gate
 *
 * Constraint: ONLY pattern features (pattern_* in feature library) can
 * be added as additional entry_conditions today, because the existing
 * EntryCondition union only supports PatternCondition / TechnicalCondition
 * / SentimentCondition. Technical features (sma200_distance, etc.) would
 * need a NEW continuous-feature-as-gate mechanism (e.g.,
 * "feature > threshold" condition type) which doesn't exist. Filed as
 * future work in ROADMAP H.4b extension if first iteration needs it.
 *
 * Wall clock: O(K × MAX_FEATURES) backtests; with K=6 + MAX_FEATURES=4,
 * ~20 backtests × ~5s each = ~2 min per candidate.
 *
 * Usage:
 *   pnpm dlx tsx scripts/canonical/stepwise-feature-augmentation.ts
 *   ALGO_ID=<uuid> MAX_FEATURES=4 MIN_DELTA_SHARPE_PCT=5 MIN_DELTA_DD_PCT=20 \
 *     pnpm dlx tsx scripts/canonical/stepwise-feature-augmentation.ts
 *
 * Env:
 *   ALGO_ID                   default v3 survivor (Engulfing rr3_lb6_r06)
 *   FEATURE_IMPORTANCE_FILE   default scripts/canonical/feature-importance-results.json
 *   TOP_K                     default 10 (only pattern_* entries from this list used)
 *   MAX_FEATURES              default 4 (cap on augmented entry_conditions added)
 *   MIN_DELTA_SHARPE_PCT      default 5  (Sharpe must improve ≥this% to keep feature)
 *   MIN_DELTA_DD_PCT          default 20 (OR max_dd must drop ≥this% to keep feature)
 *   MIN_TRADES_FLOOR          default 30 (augmented variant must retain ≥this trades;
 *                             matches per-candidate criterion 2 — without this floor
 *                             greedy selection picks features that collapse the sample
 *                             size to a handful of trades with meaningless statistical
 *                             significance, e.g. n=3 trades yielding "Sharpe +204%")
 *   AUGMENT_DIRECTION         default "bullish" (single direction tested per pattern)
 *   OUTPUT_JSON               default scripts/canonical/stepwise-augmentation-results.json
 *   PERSIST                   default 1
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { classifyAlgoForGate } from "../../src/lib/algo-search/criteria";
import { timeframeToInterval } from "../../src/lib/market-data/interval";
import { runPortfolioBacktest } from "../../src/lib/market-data/portfolio-backtest";
import type { Database } from "../../src/lib/supabase/database.types";
import type { BacktestTrade, PriceBar } from "../../src/lib/market-data/types";
import type { AlgorithmRules, EntryCondition, PatternCondition } from "../../src/types/algorithm";

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
const FEATURE_IMPORTANCE_FILE =
  process.env.FEATURE_IMPORTANCE_FILE ?? "scripts/canonical/feature-importance-results.json";
const TOP_K = Math.max(1, Number(process.env.TOP_K ?? "10"));
const MAX_FEATURES = Math.max(1, Number(process.env.MAX_FEATURES ?? "4"));
const MIN_DELTA_SHARPE_PCT = Number(process.env.MIN_DELTA_SHARPE_PCT ?? "5");
const MIN_DELTA_DD_PCT = Number(process.env.MIN_DELTA_DD_PCT ?? "20");
const MIN_TRADES_FLOOR = Math.max(1, Number(process.env.MIN_TRADES_FLOOR ?? "30"));
const AUGMENT_DIRECTION = (process.env.AUGMENT_DIRECTION ?? "bullish") as
  | "bullish"
  | "bearish";
const OUTPUT_JSON =
  process.env.OUTPUT_JSON ?? "scripts/canonical/stepwise-augmentation-results.json";
const PERSIST = process.env.PERSIST !== "0";

function fail(msg: string): never {
  console.error(`[stepwise-feature-augmentation] ${msg}`);
  process.exit(1);
}

function requireEnv(): { url: string; key: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    fail("NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY required");
  }
  return { url, key };
}

function riskDollarsFor(rules: AlgorithmRules, capital: number): number {
  const sizing = rules.position_sizing;
  if (sizing?.type === "risk_per_trade") return capital * (sizing.value / 100);
  return capital * 0.01;
}

interface Metrics {
  trades: number;
  total_r: number;
  mean_r: number;
  sharpe: number;
  max_dd_r: number;
  win_rate: number;
}

function computeMetrics(trades: readonly BacktestTrade[], riskDollars: number): Metrics {
  if (trades.length === 0) {
    return { trades: 0, total_r: 0, mean_r: 0, sharpe: 0, max_dd_r: 0, win_rate: 0 };
  }
  const r = trades.map((t) => t.pnl / riskDollars);
  const total = r.reduce((a, b) => a + b, 0);
  const mean = total / r.length;
  let var_ = 0;
  for (const x of r) var_ += (x - mean) ** 2;
  const std = Math.sqrt(var_ / r.length);
  const sharpe = std === 0 ? 0 : mean / std;
  let peak = 0, equity = 0, maxDd = 0;
  for (const x of r) {
    equity += x;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDd) maxDd = dd;
  }
  const wins = trades.filter((t) => t.pnl > 0).length;
  return {
    trades: trades.length,
    total_r: total,
    mean_r: mean,
    sharpe,
    max_dd_r: maxDd,
    win_rate: (wins / trades.length) * 100,
  };
}

/** Convert a pattern_*_signed feature name to the corresponding pattern
 *  identifier used in PatternCondition. e.g. "pattern_daily_bias_signed"
 *  → "daily_bias". Returns null for non-pattern features. */
function featureNameToPattern(name: string): PatternCondition["pattern"] | null {
  if (!name.startsWith("pattern_") || !name.endsWith("_signed")) return null;
  const middle = name.slice("pattern_".length, -("_signed".length));
  // Validation: the middle name must match a known pattern in the union.
  // We trust the H.3 feature naming convention (matches features/patterns.ts
  // pattern names 1:1). If a non-existent pattern slips through, the Zod
  // schema will reject at backtest time + we'll surface the error.
  return middle as PatternCondition["pattern"];
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
  if (error || !data) fail(`fetch algo: ${error?.message ?? "no row"}`);
  const rules = data.rules as unknown as AlgorithmRules;
  const watchlist = (data.algorithm_watchlist ?? []) as { ticker: string }[];
  if (watchlist.length === 0) fail(`algo has no watchlist tickers`);
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
  if (error || !data) fail(`no cached bars: ${error?.message}`);
  return data.bars as unknown as PriceBar[];
}

interface StepResult {
  step: number;
  added_feature: string;
  added_pattern: string;
  metrics_after: Metrics;
  delta_sharpe_pct: number;
  delta_dd_pct: number;
  candidates_considered: number;
}

async function main(): Promise<void> {
  const { url, key } = requireEnv();
  const supabase = createClient<Database>(url, key);

  console.log(`[stepwise-feature-augmentation] H.4b proper`);
  console.log(`  algo_id : ${ALGO_ID}`);
  console.log(`  top_k : ${TOP_K} (pattern features only)`);
  console.log(`  max_features : ${MAX_FEATURES}`);
  console.log(`  gate (Sharpe Δ ≥ ${MIN_DELTA_SHARPE_PCT}% OR DD Δ ≤ -${MIN_DELTA_DD_PCT}%)`);
  console.log("");

  const algo = await loadAlgo(supabase);
  const algoClass = classifyAlgoForGate(algo.rules as { entry_conditions?: Array<{ type?: string }> });
  console.log(`  algo class : ${algoClass}`);
  if (algoClass !== "pattern-triggered") {
    console.log(`  ⚠ Algo class is NOT pattern-triggered; greedy augmentation may not apply`);
    console.log(`     (continuing for diagnostic output)`);
  }

  // Load top-K pattern features
  if (!existsSync(FEATURE_IMPORTANCE_FILE)) {
    fail(`feature-importance-results.json missing — run H.3 first`);
  }
  const importance = JSON.parse(readFileSync(FEATURE_IMPORTANCE_FILE, "utf-8")) as {
    top_features?: Array<{ name: string; gain: number }>;
    all_features?: Array<{ name: string; gain: number }>;
  };
  const allTopK = (importance.top_features ?? importance.all_features ?? []).slice(0, TOP_K);
  const patternFeatures = allTopK
    .map((f) => ({ name: f.name, pattern: featureNameToPattern(f.name) }))
    .filter((f): f is { name: string; pattern: PatternCondition["pattern"] } => f.pattern !== null);

  // Exclude the algo's existing entry pattern(s) — can't add the same pattern twice
  const existingPatterns = new Set(
    (algo.rules.entry_conditions ?? [])
      .filter((c): c is PatternCondition => c.type === "pattern")
      .map((c) => c.pattern),
  );
  const eligibleFeatures = patternFeatures.filter((f) => !existingPatterns.has(f.pattern));

  console.log(`  eligible pattern features : ${eligibleFeatures.length}`);
  console.log(`    excluded (already in entry): ${[...existingPatterns].join(", ") || "(none)"}`);
  for (const f of eligibleFeatures) console.log(`    - ${f.name} → pattern="${f.pattern}"`);
  console.log("");

  if (eligibleFeatures.length === 0) {
    fail(`no eligible pattern features; nothing to augment`);
  }

  // Load bars + run baseline backtest
  const bars = await loadBars(supabase, algo.ticker, algo.timeframe);
  const pricesByTicker = new Map<string, PriceBar[]>([[algo.ticker.toUpperCase(), bars]]);
  console.log(`Running baseline backtest on ${algo.ticker} ${algo.timeframe} (${bars.length} bars)...`);
  const baseResult = runPortfolioBacktest(algo.rules, pricesByTicker, algo.capital);
  const riskDollars = riskDollarsFor(algo.rules, algo.capital);
  const baseline = computeMetrics(baseResult.trades ?? [], riskDollars);
  console.log(`  baseline: trades=${baseline.trades} total_r=${baseline.total_r.toFixed(2)} sharpe=${baseline.sharpe.toFixed(4)} max_dd_r=${baseline.max_dd_r.toFixed(2)} WR=${baseline.win_rate.toFixed(1)}%`);

  if (baseline.trades < 30) {
    console.log(`  ⚠ baseline only ${baseline.trades} trades — augmentation backtests on top will further reduce trade counts; results may be unstable`);
  }
  console.log("");

  // Greedy forward selection
  const steps: StepResult[] = [];
  let currentConditions = [...algo.rules.entry_conditions];
  let currentMetrics = baseline;
  const remaining = [...eligibleFeatures];

  for (let step = 1; step <= MAX_FEATURES; step++) {
    console.log(`── STEP ${step}: testing ${remaining.length} remaining features ──`);
    let bestFeature: typeof remaining[0] | null = null;
    let bestMetrics = currentMetrics;
    let bestDeltaSharpePct = -Infinity;

    for (const feature of remaining) {
      const testCondition: EntryCondition = {
        type: "pattern",
        pattern: feature.pattern,
        direction: AUGMENT_DIRECTION,
        timeframe: algo.timeframe,
      };
      const testConditions = [...currentConditions, testCondition];
      const testRules: AlgorithmRules = {
        ...algo.rules,
        entry_conditions: testConditions,
        entry_logic: "all",
      };
      const testResult = runPortfolioBacktest(testRules, pricesByTicker, algo.capital);
      const testMetrics = computeMetrics(testResult.trades ?? [], riskDollars);

      const dSharpePct = currentMetrics.sharpe === 0
        ? 0
        : ((testMetrics.sharpe - currentMetrics.sharpe) / Math.abs(currentMetrics.sharpe)) * 100;
      const dDdPct = currentMetrics.max_dd_r === 0
        ? 0
        : ((testMetrics.max_dd_r - currentMetrics.max_dd_r) / currentMetrics.max_dd_r) * 100;

      const passesTradeFloor = testMetrics.trades >= MIN_TRADES_FLOOR;
      const passesImprovement = dSharpePct >= MIN_DELTA_SHARPE_PCT || dDdPct <= -MIN_DELTA_DD_PCT;
      const passesGate = passesTradeFloor && passesImprovement;
      let gateMark = "✗";
      if (passesGate) gateMark = "✓";
      else if (!passesTradeFloor) gateMark = `✗ (n<${MIN_TRADES_FLOOR})`;
      console.log(`    ${feature.pattern.padEnd(25)} trades=${testMetrics.trades.toString().padStart(4)} ΔSharpe=${dSharpePct.toFixed(1).padStart(6)}% ΔDD=${dDdPct.toFixed(1).padStart(6)}% ${gateMark}`);

      if (passesGate && dSharpePct > bestDeltaSharpePct) {
        bestDeltaSharpePct = dSharpePct;
        bestFeature = feature;
        bestMetrics = testMetrics;
      }
    }

    if (bestFeature === null) {
      console.log(`    → no remaining feature passes gate; stopping at step ${step - 1}`);
      console.log("");
      break;
    }

    const finalDdPct = currentMetrics.max_dd_r === 0
      ? 0
      : ((bestMetrics.max_dd_r - currentMetrics.max_dd_r) / currentMetrics.max_dd_r) * 100;
    console.log(`    → KEPT ${bestFeature.pattern} (ΔSharpe=${bestDeltaSharpePct.toFixed(1)}%, ΔDD=${finalDdPct.toFixed(1)}%)`);
    console.log("");

    steps.push({
      step,
      added_feature: bestFeature.name,
      added_pattern: bestFeature.pattern,
      metrics_after: bestMetrics,
      delta_sharpe_pct: bestDeltaSharpePct,
      delta_dd_pct: finalDdPct,
      candidates_considered: remaining.length,
    });

    currentConditions.push({
      type: "pattern",
      pattern: bestFeature.pattern,
      direction: AUGMENT_DIRECTION,
      timeframe: algo.timeframe,
    });
    currentMetrics = bestMetrics;
    remaining.splice(remaining.indexOf(bestFeature), 1);
  }

  // Final summary
  console.log("┌──────────────────────────────────────────────────────────────────────┐");
  console.log("│ STEPWISE AUGMENTATION FINAL VERDICT                                  │");
  console.log("└──────────────────────────────────────────────────────────────────────┘");
  const augmentedCount = steps.length;
  if (augmentedCount === 0) {
    console.log("  No augmentation improves baseline beyond gate threshold.");
    console.log("  Recommended next: keep baseline as-is; no H.4b augmented family clone.");
  } else {
    const totalSharpe = currentMetrics.sharpe;
    const totalSharpePct = baseline.sharpe === 0
      ? 0
      : ((totalSharpe - baseline.sharpe) / Math.abs(baseline.sharpe)) * 100;
    const totalDdPct = baseline.max_dd_r === 0
      ? 0
      : ((currentMetrics.max_dd_r - baseline.max_dd_r) / baseline.max_dd_r) * 100;
    console.log(`  Final augmentation: +${augmentedCount} pattern features`);
    for (const s of steps) {
      console.log(`    step ${s.step}: + ${s.added_pattern}-${AUGMENT_DIRECTION}`);
    }
    console.log("");
    console.log(`  Baseline  : trades=${baseline.trades} sharpe=${baseline.sharpe.toFixed(4)} max_dd_r=${baseline.max_dd_r.toFixed(2)} WR=${baseline.win_rate.toFixed(1)}%`);
    console.log(`  Augmented : trades=${currentMetrics.trades} sharpe=${currentMetrics.sharpe.toFixed(4)} max_dd_r=${currentMetrics.max_dd_r.toFixed(2)} WR=${currentMetrics.win_rate.toFixed(1)}%`);
    console.log(`  Cumulative deltas: ΔSharpe=${totalSharpePct.toFixed(1)}%  ΔDD=${totalDdPct.toFixed(1)}%`);
    console.log("");
    console.log("  Recommended next: operator stamps clone-augmented-family with this set");
    console.log("  of features + runs run-augmented-f-f2.sh on the augmented family to");
    console.log("  re-deflate against the augmented-family selection-bias pool. If the");
    console.log("  augmented F+F2 audit returns PASS, the candidate is deployable.");
  }

  if (PERSIST) {
    const augmentedEntryConditions = currentConditions;
    const output = {
      driver: "H.4b proper — stepwise feature augmentation" as const,
      algo_id: ALGO_ID,
      algo_name: algo.name,
      algo_class: algoClass,
      ticker: algo.ticker,
      timeframe: algo.timeframe,
      gate: {
        min_delta_sharpe_pct: MIN_DELTA_SHARPE_PCT,
        min_delta_dd_pct: MIN_DELTA_DD_PCT,
        min_trades_floor: MIN_TRADES_FLOOR,
      },
      top_k: TOP_K,
      max_features: MAX_FEATURES,
      eligible_features: eligibleFeatures.map((f) => f.name),
      baseline_metrics: baseline,
      stepwise_trace: steps,
      final_metrics: currentMetrics,
      final_augmented_entry_conditions: augmentedEntryConditions,
      added_count: augmentedCount,
      recommendation: augmentedCount === 0
        ? "no_augmentation_improves"
        : "operator_stamp_clone_and_f_f2",
      generated_at: new Date().toISOString(),
    };
    writeFileSync(OUTPUT_JSON, JSON.stringify(output, null, 2));
    console.log("");
    console.log(`Persisted ${OUTPUT_JSON}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
