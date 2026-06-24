/**
 * H.4b — Augmented-variant validator: constructs v3 survivor + winning
 * feature-filter (per H.4-methodology-revision verdict), backtests +
 * checks per-candidate criteria, reports delta-Sharpe + delta-DD vs
 * baseline.
 *
 * DOES NOT mutate algorithms table — runs in-memory. If the augmented
 * variant passes per-candidate criteria with meaningful Sharpe boost,
 * operator stamps the clone-to-DB-then-F2 next step.
 *
 * Method:
 *   1. Load v3 survivor's rules + bars
 *   2. Run baseline backtest → record metrics
 *   3. Construct augmented rules (entry_conditions = [Engulfing, daily_bias_BULLISH]
 *      with entry_logic = "all" so both must fire)
 *   4. Run augmented backtest
 *   5. Compute per-candidate criteria (1-7) on augmented stats
 *   6. Report: deltas + per-candidate verdict + Sharpe + DD comparison
 *
 * Filter chosen per H.4-methodology-revision empirical: pattern_daily_bias_signed
 * veto-low (= "only enter when daily_bias is non-bearish") was the top-ranked
 * filter at Sharpe +49.4% / max-DD -36.5%.
 *
 * Operator override: set AUGMENT_PATTERN=<name> to use a different pattern
 * filter (must match a PatternCondition type — order_block, bos, etc.).
 * Default = daily_bias (the empirical winner).
 *
 * Usage:
 *   pnpm dlx tsx scripts/canonical/augmented-variant-validate.ts
 *   AUGMENT_PATTERN=order_block pnpm dlx tsx scripts/canonical/augmented-variant-validate.ts
 *
 * Wall clock: ~10s (2 backtests).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { evaluateAgainstCriteria, passesPerCandidate, type PersistedBacktestResults } from "../../src/lib/algo-search/criteria";
import { timeframeToInterval } from "../../src/lib/market-data/interval";
import { runPortfolioBacktest } from "../../src/lib/market-data/portfolio-backtest";
import { bootstrapStatBlock } from "../../src/lib/stats/bootstrap";
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
  } catch { /* operator exports envs themselves */ }
}
loadEnvLocal();

const ALGO_ID = process.env.ALGO_ID ?? "33b705b9-7442-4c73-8d97-4a88ecacb9a1";
const AUGMENT_PATTERN = process.env.AUGMENT_PATTERN ?? "daily_bias";
const AUGMENT_DIRECTION = (process.env.AUGMENT_DIRECTION ?? "bullish") as "bullish" | "bearish";
const OUTPUT_JSON = process.env.OUTPUT_JSON ?? "scripts/canonical/augmented-variant-results.json";
const PERSIST = process.env.PERSIST !== "0";
const BOOTSTRAP_ITERATIONS = Number(process.env.BOOTSTRAP_ITERATIONS ?? 2000);
const BOOTSTRAP_SEED = Number(process.env.BOOTSTRAP_SEED ?? 42);
const OOS_CUTOFF = process.env.OOS_CUTOFF ?? "2025-06-18";

function fail(msg: string): never {
  console.error(`[augmented-variant-validate] ${msg}`);
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

interface Metrics {
  trades: number;
  total_r: number;
  mean_r: number;
  total_return: number;
  sharpe: number;
  max_dd_r: number;
  max_static_dd_pct: number;
  max_daily_dd_pct: number;
  win_rate: number;
}

function computeMetrics(trades: readonly BacktestTrade[], riskDollars: number, propReport: { peak_drawdown?: number; max_daily_loss?: number } | undefined, capital: number, totalReturn: number): Metrics {
  if (trades.length === 0) {
    return {
      trades: 0, total_r: 0, mean_r: 0, total_return: 0, sharpe: 0,
      max_dd_r: 0, max_static_dd_pct: 0, max_daily_dd_pct: 0, win_rate: 0,
    };
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
  const winRate = (wins / trades.length) * 100;
  const peakDdDollars = propReport?.peak_drawdown ?? 0;
  const dailyLossDollars = propReport?.max_daily_loss ?? 0;
  return {
    trades: trades.length,
    total_r: total,
    mean_r: mean,
    total_return: totalReturn,
    sharpe,
    max_dd_r: maxDd,
    max_static_dd_pct: capital > 0 ? (peakDdDollars / capital) * 100 : 0,
    max_daily_dd_pct: capital > 0 ? (dailyLossDollars / capital) * 100 : 0,
    win_rate: winRate,
  };
}

async function main(): Promise<void> {
  const { url, key } = requireEnv();
  const supabase = createClient<Database>(url, key);

  console.log(`[augmented-variant-validate] H.4b augmented-variant pre-flight`);
  console.log(`  algo_id: ${ALGO_ID}`);
  console.log(`  augment with: ${AUGMENT_PATTERN}-${AUGMENT_DIRECTION}`);
  console.log("");

  const { data, error } = await supabase
    .from("algorithms")
    .select("id, name, rules, capital, algorithm_watchlist(ticker)")
    .eq("id", ALGO_ID)
    .single();
  if (error || !data) fail(`Failed to fetch algo: ${error?.message}`);
  const baseRules = data.rules as unknown as AlgorithmRules;
  const capital = Number(data.capital);
  const watchlist = (data.algorithm_watchlist ?? []) as { ticker: string }[];
  if (watchlist.length === 0) fail(`Algo has no watchlist tickers`);
  const ticker = watchlist[0].ticker;
  const timeframe = baseRules.timeframe;

  const interval = timeframeToInterval(timeframe);
  const { data: barData, error: barErr } = await supabase
    .from("price_cache")
    .select("bars")
    .eq("ticker", ticker.toUpperCase())
    .eq("output_size", "full")
    .eq("interval", interval)
    .limit(1)
    .single();
  if (barErr || !barData) fail(`No cached bars: ${barErr?.message}`);
  const bars = barData.bars as unknown as PriceBar[];
  const pricesByTicker = new Map<string, PriceBar[]>([[ticker.toUpperCase(), bars]]);
  console.log(`  ${bars.length} bars`);
  console.log(`  Baseline entry_conditions: ${JSON.stringify(baseRules.entry_conditions)}`);
  console.log(`  Baseline entry_logic: ${baseRules.entry_logic}`);

  console.log("");
  console.log("Running BASELINE backtest...");
  const baseResult = runPortfolioBacktest(baseRules, pricesByTicker, capital);
  const baseTrades = baseResult.trades ?? [];
  const riskDollars = riskDollarsFor(baseRules, capital);
  const baseline = computeMetrics(baseTrades, riskDollars, baseResult.prop_firm_report, capital, baseResult.total_return);
  console.log(`  trades=${baseline.trades} total_r=${baseline.total_r.toFixed(2)} sharpe=${baseline.sharpe.toFixed(4)} static_dd=${baseline.max_static_dd_pct.toFixed(2)}% daily_dd=${baseline.max_daily_dd_pct.toFixed(2)}% WR=${baseline.win_rate.toFixed(1)}%`);

  console.log("");
  console.log("Constructing AUGMENTED rules + running augmented backtest...");
  const augmentCondition: EntryCondition = {
    type: "pattern",
    pattern: AUGMENT_PATTERN as never,
    direction: AUGMENT_DIRECTION,
    timeframe,
  };
  const augmentedRules: AlgorithmRules = {
    ...baseRules,
    entry_conditions: [...baseRules.entry_conditions, augmentCondition],
    entry_logic: "all", // both Engulfing + daily_bias must fire
  };
  console.log(`  Augmented entry_conditions: ${JSON.stringify(augmentedRules.entry_conditions)}`);

  const augResult = runPortfolioBacktest(augmentedRules, pricesByTicker, capital);
  const augTrades = augResult.trades ?? [];
  const augmented = computeMetrics(augTrades, riskDollars, augResult.prop_firm_report, capital, augResult.total_return);
  console.log(`  trades=${augmented.trades} total_r=${augmented.total_r.toFixed(2)} sharpe=${augmented.sharpe.toFixed(4)} static_dd=${augmented.max_static_dd_pct.toFixed(2)}% daily_dd=${augmented.max_daily_dd_pct.toFixed(2)}% WR=${augmented.win_rate.toFixed(1)}%`);

  // Compute mean_r bootstrap CI for augmented (in-sample only; everything pre-OOS)
  const cutMs = new Date(OOS_CUTOFF).getTime();
  const inSampleAug = augTrades.filter((t) => new Date(t.entry_date).getTime() < cutMs);
  const oosAug = augTrades.filter((t) => new Date(t.entry_date).getTime() >= cutMs);
  const meanRFn = (sample: BacktestTrade[]): number => {
    if (sample.length === 0) return 0;
    return sample.reduce((acc, t) => acc + t.pnl / riskDollars, 0) / sample.length;
  };
  let augCiLower = 0;
  if (inSampleAug.length >= 2) {
    const ci = bootstrapStatBlock<BacktestTrade>(inSampleAug, meanRFn, {
      n_iterations: BOOTSTRAP_ITERATIONS,
      seed: BOOTSTRAP_SEED,
    });
    augCiLower = ci.lower;
  }
  const inMeanR = meanRFn(inSampleAug);
  const oosMeanR = meanRFn(oosAug);
  const oosDeltaPct = inMeanR === 0 ? 0 : ((oosMeanR - inMeanR) / Math.abs(inMeanR)) * 100;

  // Per-candidate gate (1-7) check via the standard criteria evaluator
  const persistedShape: PersistedBacktestResults = {
    step2: {
      total_return: augmented.total_return,
      total_trades: augmented.trades,
      win_rate: augmented.win_rate,
      max_static_dd: augmented.max_static_dd_pct,
      max_daily_dd: augmented.max_daily_dd_pct,
    },
    step6: {
      held_out_n: oosAug.length,
      r_delta_pct: oosDeltaPct,
    },
    statistical_rigor: { mean_r_ci: { lower: augCiLower } },
  };

  console.log("");
  console.log("Per-candidate criteria (1-7) on AUGMENTED:");
  const criteriaResults = evaluateAgainstCriteria(persistedShape);
  for (const c of criteriaResults) {
    const mark = c.passed ? "✓" : "✗";
    const obs = c.observed === null ? "—" : c.observed.toFixed(4);
    console.log(`  ${mark} ${c.label.padEnd(35)} observed=${obs.padStart(10)} threshold=${c.threshold}`);
  }
  const passesGate = passesPerCandidate(persistedShape);

  // Delta analytics
  const dSharpePct = baseline.sharpe === 0 ? 0 : ((augmented.sharpe - baseline.sharpe) / baseline.sharpe) * 100;
  const dDdPct = baseline.max_dd_r === 0 ? 0 : ((augmented.max_dd_r - baseline.max_dd_r) / baseline.max_dd_r) * 100;
  const dTradeCountPct = baseline.trades === 0 ? 0 : ((augmented.trades - baseline.trades) / baseline.trades) * 100;
  const dStaticDdPct = baseline.max_static_dd_pct === 0 ? 0 : ((augmented.max_static_dd_pct - baseline.max_static_dd_pct) / baseline.max_static_dd_pct) * 100;

  console.log("");
  console.log(`AUGMENTED vs BASELINE deltas:`);
  console.log(`  Sharpe : ${baseline.sharpe.toFixed(4)} → ${augmented.sharpe.toFixed(4)} (${dSharpePct >= 0 ? "+" : ""}${dSharpePct.toFixed(1)}%)`);
  console.log(`  Max-DD (R) : ${baseline.max_dd_r.toFixed(2)} → ${augmented.max_dd_r.toFixed(2)} (${dDdPct >= 0 ? "+" : ""}${dDdPct.toFixed(1)}%)`);
  console.log(`  Static DD (%) : ${baseline.max_static_dd_pct.toFixed(2)}% → ${augmented.max_static_dd_pct.toFixed(2)}% (${dStaticDdPct >= 0 ? "+" : ""}${dStaticDdPct.toFixed(1)}%)`);
  console.log(`  Trades : ${baseline.trades} → ${augmented.trades} (${dTradeCountPct >= 0 ? "+" : ""}${dTradeCountPct.toFixed(1)}%)`);
  console.log(`  Mean R : ${baseline.mean_r.toFixed(4)} → ${augmented.mean_r.toFixed(4)}`);
  console.log(`  Win rate : ${baseline.win_rate.toFixed(1)}% → ${augmented.win_rate.toFixed(1)}%`);

  console.log("");
  console.log(`AUGMENTED VARIANT PER-CANDIDATE GATE: ${passesGate ? "PASS" : "FAIL"}`);
  if (passesGate) {
    console.log("");
    console.log("Next steps (operator stamp required):");
    console.log("  1. Clone v3 survivor + 95 sibling variants to DB with augmented entry_conditions");
    console.log("     (new family name: 'LayerB+: XAU/USD Engulfing-Long-DBfilter 4h | ...')");
    console.log("  2. Run revalidate-candidates on augmented family → DSR + PBO + k-fold");
    console.log("  3. Run F2 audit on augmented family");
    console.log("  4. IF augmented passes F + F2: deploy candidate (G.6 re-stamp)");
  } else {
    console.log("");
    console.log("Augmented variant fails per-candidate floor — check which criteria failed above.");
    console.log("Common cause: filter too aggressive, leaving too few held-out trades (criterion 6).");
  }

  if (PERSIST) {
    const output = {
      base_algo_id: ALGO_ID,
      augment_pattern: AUGMENT_PATTERN,
      augment_direction: AUGMENT_DIRECTION,
      baseline,
      augmented,
      deltas: {
        sharpe_pct: dSharpePct,
        max_dd_pct: dDdPct,
        static_dd_pct: dStaticDdPct,
        trade_count_pct: dTradeCountPct,
      },
      augmented_in_sample_mean_r: inMeanR,
      augmented_oos_mean_r: oosMeanR,
      augmented_oos_delta_pct: oosDeltaPct,
      augmented_mean_r_ci_lower: augCiLower,
      per_candidate_results: criteriaResults,
      per_candidate_passes: passesGate,
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
