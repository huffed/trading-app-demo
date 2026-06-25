/**
 * H.9 Bayesian Optimization driver — runs BO over Layer B 5-axis space
 * for a single per-candidate-passer base. Replaces the 96-variant grid
 * with adaptive peak-finding search.
 *
 * Operator-stamped 2026-06-25 after 2 consecutive F+F2 failures
 * (v3 Engulfing + ARB top) showed grid-search produces flat Sharpe
 * distributions at retail data volume — winners selected by tiny noise
 * differences that don't survive F2.3 bootstrap-bars + PBO. BO surfaces
 * candidates with discriminating Sharpe gaps that should pass at strict
 * thresholds.
 *
 * Architecture:
 *   - TS driver: orchestrates the eval loop, runs backtests via
 *     runPortfolioBacktest, persists history.
 *   - Python sidecar: stateless scikit-optimize wrapper. Spawned per
 *     iteration with full eval_history → returns next-suggested params.
 *
 * Wall clock: 30-60 evaluations × ~5s/backtest = 3-5 min per base.
 *
 * Output: scripts/canonical/bo-results/<slug>.json with full eval history
 * + top-K candidates ranked by Sharpe + descriptive stats vs grid family.
 *
 * Usage:
 *   pnpm dlx tsx scripts/canonical/bo-search.ts
 *   BASE_NAME="Search: XAU/USD AsianRangeBreak-Long 4h" \
 *     N_EVALS=60 N_INITIAL=10 \
 *     pnpm dlx tsx scripts/canonical/bo-search.ts
 *
 * Env:
 *   BASE_NAME           default "Search: XAU/USD AsianRangeBreak-Long 4h"
 *                       (one of the E2 per-candidate passers)
 *   N_EVALS             default 60 (total BO evaluations)
 *   N_INITIAL           default 10 (random samples before GP surrogate)
 *   ACQ_FUNC            default "EI" (expected improvement)
 *   RANDOM_SEED         default 42
 *   TOP_K               default 5 (top candidates persisted)
 *   OUTPUT_DIR          default scripts/canonical/bo-results
 *   PYTHON_BIN          default scripts/python/.venv/bin/python (auto-detected)
 *   PERSIST             default 1
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  applyBoParams,
  bestEntry,
  boVariantTag,
  computeSharpe,
  decodeParams,
  LAYER_B_BO_DIMENSIONS,
  sortedByObjective,
  type BoEvalEntry,
  type BoSidecarRequest,
  type BoSidecarResponse,
} from "../../src/lib/algo-search/bayesian-optimization";
import { timeframeToInterval } from "../../src/lib/market-data/interval";
import { runPortfolioBacktest } from "../../src/lib/market-data/portfolio-backtest";
import type { Database } from "../../src/lib/supabase/database.types";
import type { BacktestTrade, PriceBar } from "../../src/lib/market-data/types";
import type { AlgorithmRules } from "../../src/types/algorithm";

function loadEnvLocal(): void {
  try {
    const raw = readFileSync(resolve(process.cwd(), ".env.local"), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (!m) continue;
      const [, k, v] = m;
      if (!process.env[k]) process.env[k] = v.replace(/^['"]|['"]$/g, "");
    }
  } catch { /* operator exports envs */ }
}
loadEnvLocal();

const BASE_NAME = process.env.BASE_NAME ?? "Search: XAU/USD AsianRangeBreak-Long 4h";
const N_EVALS = Math.max(5, Number(process.env.N_EVALS ?? "60"));
const N_INITIAL = Math.max(2, Number(process.env.N_INITIAL ?? "10"));
const ACQ_FUNC = (process.env.ACQ_FUNC ?? "EI") as "EI" | "PI" | "LCB" | "gp_hedge";
const RANDOM_SEED = Number(process.env.RANDOM_SEED ?? "42");
const TOP_K = Math.max(1, Number(process.env.TOP_K ?? "5"));
const OUTPUT_DIR = process.env.OUTPUT_DIR ?? "scripts/canonical/bo-results";
const VENV_PYTHON = resolve(process.cwd(), "scripts/python/.venv/bin/python");
const PYTHON_BIN = process.env.PYTHON_BIN ?? (existsSync(VENV_PYTHON) ? VENV_PYTHON : "python3");
const PYTHON_SIDECAR = resolve(process.cwd(), "scripts/python/bayesian_optimization.py");
const PERSIST = process.env.PERSIST !== "0";

function fail(msg: string): never {
  console.error(`[bo-search] ${msg}`);
  process.exit(1);
}

/** Deterministic mulberry32 PRNG. Matches the implementation in
 *  src/lib/stats/bootstrap.ts (kept local to avoid an import for one
 *  helper). Used to generate diverse random initial points BEFORE
 *  handing off to the BO sidecar — works around scikit-optimize's
 *  stateless-reinit issue where the same seed always produces the
 *  same first random point regardless of telled history. */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Generate N diverse random initial points across the LAYER_B_BO_DIMENSIONS.
 *  Each dimension sampled uniformly per its bounds + type (Integer
 *  rounded). Pure function; same seed → same points. */
function generateInitialPoints(n: number, seed: number): number[][] {
  const rng = mulberry32(seed);
  const out: number[][] = [];
  for (let i = 0; i < n; i++) {
    const point: number[] = [];
    for (const dim of LAYER_B_BO_DIMENSIONS) {
      const u = rng();
      if (dim.type === "Integer") {
        point.push(Math.floor(u * (dim.high - dim.low + 1)) + dim.low);
      } else {
        point.push(u * (dim.high - dim.low) + dim.low);
      }
    }
    out.push(point);
  }
  return out;
}

function requireEnv(): { url: string; key: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) fail("NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY required");
  return { url, key };
}

function extractTicker(name: string): string {
  return name.replace(/^(Search|LayerB\+?):\s*/, "").split(" ")[0] ?? "XAU/USD";
}

function extractTimeframe(name: string): string {
  return name.match(/\s(\d+[mh])\s/)?.[1] ?? "4h";
}

function riskDollarsFor(rules: AlgorithmRules, capital: number): number {
  const sizing = rules.position_sizing;
  if (sizing?.type === "risk_per_trade") return capital * (sizing.value / 100);
  return capital * 0.01;
}

function perTradeR(trades: readonly BacktestTrade[], risk: number): number[] {
  if (risk <= 0) return [];
  return trades.map((t) => t.pnl / risk);
}

/** Spawn the Python sidecar once with the current eval history; receive
 *  next-suggested params. Sidecar is stateless — re-init each call. */
function askSidecar(history: BoEvalEntry[]): Promise<BoSidecarResponse> {
  return new Promise((resolvePromise, rejectPromise) => {
    const request: BoSidecarRequest = {
      dimensions: LAYER_B_BO_DIMENSIONS,
      eval_history: history,
      n_initial_points: N_INITIAL,
      acq_func: ACQ_FUNC,
      random_seed: RANDOM_SEED,
    };
    const proc = spawn(PYTHON_BIN, [PYTHON_SIDECAR], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("error", (err) =>
      rejectPromise(new Error(`failed to spawn ${PYTHON_BIN}: ${err.message}`)),
    );
    proc.on("close", (code) => {
      if (code !== 0) {
        rejectPromise(new Error(`sidecar exited ${code}. stderr: ${stderr.trim()}`));
        return;
      }
      try {
        resolvePromise(JSON.parse(stdout) as BoSidecarResponse);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        rejectPromise(new Error(`failed to parse sidecar stdout: ${msg}\nraw: ${stdout.slice(0, 500)}`));
      }
    });
    proc.stdin.write(JSON.stringify(request));
    proc.stdin.end();
  });
}

async function loadBase(supabase: SupabaseClient<Database>): Promise<{
  rules: AlgorithmRules;
  capital: number;
  ticker: string;
  timeframe: string;
}> {
  const { data, error } = await supabase
    .from("algorithms")
    .select("rules, capital")
    .eq("name", BASE_NAME)
    .single();
  if (error || !data) fail(`fetch base algo ${BASE_NAME}: ${error?.message ?? "no row"}`);
  return {
    rules: data.rules as unknown as AlgorithmRules,
    capital: Number(data.capital),
    ticker: extractTicker(BASE_NAME),
    timeframe: extractTimeframe(BASE_NAME),
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
  if (error || !data) fail(`no cached bars for ${ticker} ${interval}: ${error?.message}`);
  return data.bars as unknown as PriceBar[];
}

async function main(): Promise<void> {
  const { url, key } = requireEnv();
  const supabase = createClient<Database>(url, key);

  console.log(`[bo-search] H.9 Bayesian Optimization`);
  console.log(`  base   : ${BASE_NAME}`);
  console.log(`  n_evals: ${N_EVALS} (initial random: ${N_INITIAL})`);
  console.log(`  acq    : ${ACQ_FUNC}, seed: ${RANDOM_SEED}`);
  console.log("");

  const base = await loadBase(supabase);
  const bars = await loadBars(supabase, base.ticker, base.timeframe);
  console.log(`  ${base.ticker} ${base.timeframe} : ${bars.length} bars`);
  console.log("");

  const pricesByTicker = new Map<string, PriceBar[]>([[base.ticker.toUpperCase(), bars]]);
  const history: BoEvalEntry[] = [];

  // Phase 1: TS-controlled random initial points (works around sidecar's
  // stateless-reinit duplicate-point bug). Backtest each + add to history
  // BEFORE handing off to sidecar's GP/EI phase.
  const initialPoints = generateInitialPoints(N_INITIAL, RANDOM_SEED);
  console.log(`Phase 1 (TS-random): ${N_INITIAL} initial points`);

  function evalAndLog(params: number[], iter: number, phase: string): void {
    const augmentedRules = applyBoParams(base.rules, params);
    const riskDollars = riskDollarsFor(augmentedRules, base.capital);
    const result = runPortfolioBacktest(augmentedRules, pricesByTicker, base.capital);
    const trades = result.trades ?? [];
    const r = perTradeR(trades, riskDollars);
    const sharpe = computeSharpe(r);
    const tag = boVariantTag(params);
    history.push({ params, objective: -sharpe, sharpe, variant_tag: tag });
    const decoded = decodeParams(params, LAYER_B_BO_DIMENSIONS);
    console.log(
      `  iter ${String(iter).padStart(2)} [${phase.padEnd(8)}] ${tag.padEnd(28)} ` +
      `rr=${decoded.rr_multiple.toFixed(2)} lb=${decoded.sl_lookback} ` +
      `risk=${decoded.risk_per_trade_pct.toFixed(2)} rf=${decoded.regime_filter} af=${decoded.adx_filter} ` +
      `| trades=${trades.length} sharpe=${sharpe.toFixed(4)}`,
    );
  }

  for (let i = 0; i < initialPoints.length; i++) {
    evalAndLog(initialPoints[i], i + 1, "TS-random");
  }

  console.log("");
  console.log(`Phase 2 (sidecar GP/EI): ${N_EVALS - N_INITIAL} adaptive evaluations`);

  for (let iter = N_INITIAL + 1; iter <= N_EVALS; iter++) {
    const response = await askSidecar(history);
    const params = response.next_params;
    const phase = response.is_initial_random_phase ? "sidecar-rd" : "GP/EI";
    evalAndLog(params, iter, phase);
  }

  console.log("");
  console.log("┌──────────────────────────────────────────────────────────────────────┐");
  console.log("│ H.9 BO RESULTS                                                       │");
  console.log("└──────────────────────────────────────────────────────────────────────┘");
  const sorted = sortedByObjective(history);
  const top = sorted.slice(0, TOP_K);
  console.log(`  top-${TOP_K} by Sharpe:`);
  for (let i = 0; i < top.length; i++) {
    const e = top[i];
    console.log(`    ${i + 1}. ${e.variant_tag?.padEnd(28)} sharpe=${e.sharpe?.toFixed(4)}`);
  }

  // Discrimination: gap between #1 and #5 (≥0.1 indicates BO found a real peak)
  const best = bestEntry(history);
  const fifth = sorted[Math.min(4, sorted.length - 1)];
  const gap = best && fifth ? (best.sharpe ?? 0) - (fifth.sharpe ?? 0) : 0;
  console.log("");
  console.log(`  Sharpe gap (1st vs 5th): ${gap.toFixed(4)}`);
  console.log(`  ${gap >= 0.1 ? "✓" : "⚠"} ${gap >= 0.1 ? "Discriminating peak — likely passes F2.3 + PBO at strict thresholds" : "Flat-ish surface — may still fail F2.3 + PBO; consider more evals or different BO seed"}`);

  if (PERSIST) {
    mkdirSync(OUTPUT_DIR, { recursive: true });
    const slug = BASE_NAME.replace(/[/\s|:]+/g, "_");
    const outPath = resolve(OUTPUT_DIR, `${slug}.json`);
    const output = {
      base_name: BASE_NAME,
      ticker: base.ticker,
      timeframe: base.timeframe,
      bar_count: bars.length,
      n_evals: N_EVALS,
      n_initial: N_INITIAL,
      acq_func: ACQ_FUNC,
      random_seed: RANDOM_SEED,
      dimensions: LAYER_B_BO_DIMENSIONS,
      eval_history: history,
      top_k: top,
      sharpe_gap_1st_vs_5th: gap,
      generated_at: new Date().toISOString(),
    };
    writeFileSync(outPath, JSON.stringify(output, null, 2));
    console.log("");
    console.log(`Persisted ${outPath}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
