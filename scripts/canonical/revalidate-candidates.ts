/**
 * Re-validate selected candidates under deflated statistics — DSR + PBO +
 * (already-persisted) purged k-fold CV.
 *
 * Generic: takes any set of algo names via the TARGETS env var. Auto-derives
 * each target's "family" (the trial pool that determines selection-bias N for
 * DSR + the variant set for PBO's CSCV) from the name pattern. Re-runs
 * portfolio-backtest per family member to capture per-trade returns + per-
 * period returns matrix, then computes:
 *   - DSR (selection-bias-adjusted Sharpe; Bailey & López de Prado 2014)
 *   - PBO via CSCV (overfit probability; Bailey/Borwein/Prado/Zhu 2014)
 *   - Reads existing purged_kfold from JSONB (already populated by validate-
 *     algo when run with KFOLD=N; this script does NOT re-run that)
 *
 * Persists a `statistical_rigor.deflated` sub-block to each target's
 * `algorithms.backtest_results` JSONB. Idempotent — re-running overwrites.
 *
 * Used by:
 *   - operator on demand (Stage 6.7-style candidate re-validation)
 *   - future walk-forward-opt cron (ROADMAP G.5) when evaluating refit candidates
 *   - any time selection-bias-adjusted stats are needed for a candidate set
 *
 * Family auto-derivation from target name:
 *   "X | tag"   → family pattern "X | %"   (LayerB-style geometry variants)
 *   "X"         → family pattern "X | %"   (treats name as base prefix)
 *   FAMILY_FOR_<index> env override available for arbitrary mappings (1-indexed)
 *
 * Usage:
 *   TARGETS="LayerB: XAU/USD BOS-Long 4h | rr3_lb3_r06_rf0_af0" \
 *     pnpm dlx tsx scripts/canonical/revalidate-candidates.ts
 *
 *   # Multiple targets (auto-grouped by family):
 *   TARGETS="A | rr3,A | rr5,B | rr3" pnpm dlx tsx ...
 *
 *   # Adjust PBO CSCV split count (default 8 → C(8,4)=70 combinations):
 *   NSPLITS=10 TARGETS=... pnpm dlx tsx ...
 *
 *   # Dry-run (compute + print but don't write JSONB):
 *   PERSIST=0 TARGETS=... pnpm dlx tsx ...
 *
 * Wall clock: ~5s per family-variant backtest. For a 96-variant family,
 * one family ≈ 8 min. Multiple families processed sequentially.
 */
import { readFileSync } from "fs";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { computeDeflatedSharpe, type DeflatedSharpeResult } from "../../src/lib/stats/deflated-sharpe";
import { timeframeToInterval } from "../../src/lib/market-data/interval";
import { runPortfolioBacktest } from "../../src/lib/market-data/portfolio-backtest";
import {
  computeProbabilityOfBacktestOverfitting,
  type PboResult,
} from "../../src/lib/stats/pbo";
import type { Database } from "../../src/lib/supabase/database.types";
import type { BacktestTrade, PriceBar } from "../../src/lib/market-data/types";
import type { AlgorithmRules } from "../../src/types/algorithm";

// .env.local loader (mirrors validate-algo / algo-search drivers)
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

const NSPLITS = Number(process.env.NSPLITS ?? 8);
const PERSIST = process.env.PERSIST !== "0";
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const FAMILY_DELIM = " | ";

interface VariantRow {
  id: string;
  name: string;
  rules: AlgorithmRules;
  capital: number;
}

interface VariantStats {
  name: string;
  trades: BacktestTrade[];
  sharpe: number;
  perTradeR: number[];
  weeklyReturns: number[];
  riskDollars: number;
}

function requireEnv(): { url: string; key: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error(
      "revalidate-candidates requires NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY " +
        "(preferred) or NEXT_PUBLIC_SUPABASE_ANON_KEY in .env.local.",
    );
  }
  return { url, key };
}

/** Derive family-pattern (SQL LIKE pattern) from a target name. */
function deriveFamilyPattern(name: string, indexOneBased: number): string {
  const override = process.env[`FAMILY_FOR_${indexOneBased}`];
  if (override) return override;
  const delimIdx = name.lastIndexOf(FAMILY_DELIM);
  const base = delimIdx > 0 ? name.slice(0, delimIdx) : name;
  return `${base}${FAMILY_DELIM}%`;
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

function sharpeFromTrades(trades: BacktestTrade[], riskDollars: number): number {
  if (trades.length < 2 || riskDollars === 0) return 0;
  const r = trades.map((t) => t.pnl / riskDollars);
  let sum = 0;
  for (const x of r) sum += x;
  const mean = sum / r.length;
  let m2 = 0;
  for (const x of r) m2 += (x - mean) ** 2;
  const std = Math.sqrt(m2 / r.length);
  return std === 0 ? 0 : mean / std;
}

function buildWeeklyReturns(
  trades: BacktestTrade[],
  riskDollars: number,
  gridStartMs: number,
  weekCount: number,
): number[] {
  const out = new Array(weekCount).fill(0);
  for (const t of trades) {
    const exitMs = new Date(t.exit_date).getTime();
    const weekIdx = Math.floor((exitMs - gridStartMs) / WEEK_MS);
    if (weekIdx >= 0 && weekIdx < weekCount) {
      out[weekIdx] += t.pnl / riskDollars;
    }
  }
  return out;
}

function riskDollarsFor(rules: AlgorithmRules, capital: number): number {
  const sizing = rules.position_sizing;
  if (sizing?.type === "risk_per_trade") return capital * (sizing.value / 100);
  return capital * 0.01;
}

function stdOf(values: number[]): number {
  if (values.length < 2) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  const mean = sum / values.length;
  let m2 = 0;
  for (const v of values) m2 += (v - mean) ** 2;
  return Math.sqrt(m2 / values.length);
}

/** Extract ticker from canonical naming convention:
 *  "Search: TICKER PATTERN-SIDE TF" → TICKER
 *  "LayerB: TICKER PATTERN-SIDE TF | tag" → TICKER */
function extractTicker(name: string): string {
  const noPrefix = name.replace(/^(Search|LayerB\+?):\s*/, "");
  const tokens = noPrefix.split(" ");
  return tokens[0] ?? "XAU/USD";
}

async function runFamilyBacktests(
  supabase: SupabaseClient<Database>,
  familyPattern: string,
  barsCache: Map<string, PriceBar[]>,
): Promise<VariantStats[]> {
  const { data: rows, error } = await supabase
    .from("algorithms")
    .select("id, name, rules, capital")
    .like("name", familyPattern);
  if (error) throw new Error(`Failed to fetch family ${familyPattern}: ${error.message}`);
  if (!rows || rows.length === 0) throw new Error(`No rows for family ${familyPattern}`);

  const variants: VariantRow[] = rows.map((r) => ({
    id: r.id,
    name: r.name,
    rules: r.rules as unknown as AlgorithmRules,
    capital: Number(r.capital),
  }));

  console.log(`\n[${familyPattern}] ${variants.length} variants → running backtests...`);

  const partial: Array<{
    name: string;
    trades: BacktestTrade[];
    sharpe: number;
    perTradeR: number[];
    riskDollars: number;
    entryMin: number;
    exitMax: number;
  }> = [];

  for (let i = 0; i < variants.length; i++) {
    const v = variants[i];
    const ticker = extractTicker(v.name);
    const timeframe = v.rules.timeframe;
    let bars = barsCache.get(`${ticker}|${timeframe}`);
    if (!bars) {
      bars = await loadBars(supabase, ticker, timeframe);
      barsCache.set(`${ticker}|${timeframe}`, bars);
      console.log(`  Loaded ${bars.length} ${ticker} ${timeframe} bars`);
    }
    const pricesByTicker = new Map([[ticker, bars]]);
    const metrics = runPortfolioBacktest(v.rules, pricesByTicker, v.capital);
    // BacktestMetrics has trades: BacktestTrade[] at top level; per_ticker[].trades is a COUNT.
    const trades: BacktestTrade[] = metrics.trades ?? [];
    const riskDollars = riskDollarsFor(v.rules, v.capital);
    const sharpe = sharpeFromTrades(trades, riskDollars);
    const perTradeR = trades.map((t) => t.pnl / riskDollars);
    let entryMin = Infinity;
    let exitMax = -Infinity;
    for (const t of trades) {
      const eMs = new Date(t.entry_date).getTime();
      const xMs = new Date(t.exit_date).getTime();
      if (eMs < entryMin) entryMin = eMs;
      if (xMs > exitMax) exitMax = xMs;
    }
    partial.push({ name: v.name, trades, sharpe, perTradeR, riskDollars, entryMin, exitMax });
    if ((i + 1) % 20 === 0 || i === variants.length - 1) {
      console.log(`  [${familyPattern}] ${i + 1}/${variants.length} backtested`);
    }
  }

  let globalMin = Infinity;
  let globalMax = -Infinity;
  for (const p of partial) {
    if (Number.isFinite(p.entryMin) && p.entryMin < globalMin) globalMin = p.entryMin;
    if (Number.isFinite(p.exitMax) && p.exitMax > globalMax) globalMax = p.exitMax;
  }
  if (!Number.isFinite(globalMin) || !Number.isFinite(globalMax)) {
    throw new Error(`Family ${familyPattern} produced no trades across any variant; can't compute PBO grid.`);
  }
  const weekCount = Math.ceil((globalMax - globalMin) / WEEK_MS) + 1;
  console.log(`  [${familyPattern}] time grid: ${weekCount} weeks`);

  return partial.map((p) => ({
    name: p.name,
    trades: p.trades,
    sharpe: p.sharpe,
    perTradeR: p.perTradeR,
    weeklyReturns: buildWeeklyReturns(p.trades, p.riskDollars, globalMin, weekCount),
    riskDollars: p.riskDollars,
  }));
}

interface DeflatedStatsPayload {
  computed_at: string;
  family_pattern: string;
  family_size: number;
  family_trial_sharpe_std: number;
  family_sharpe_mean: number;
  deflated_sharpe: DeflatedSharpeResult;
  pbo: PboResult;
  /** Snapshot of statistical_rigor.purged_kfold at compute time (source-of-
   *  truth lives in same JSONB; inlining keeps verdict reproducible from one read). */
  purged_kfold_snapshot: unknown;
}

interface ExistingBacktestResults {
  statistical_rigor?: {
    purged_kfold?: unknown;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

async function persistDeflated(
  supabase: SupabaseClient<Database>,
  variantName: string,
  payload: DeflatedStatsPayload,
): Promise<void> {
  const { data: row, error } = await supabase
    .from("algorithms")
    .select("id, backtest_results")
    .eq("name", variantName)
    .maybeSingle();
  if (error) throw new Error(`Failed to fetch ${variantName} for persist: ${error.message}`);
  if (!row) throw new Error(`Row not found: ${variantName}`);

  const current = (row.backtest_results ?? {}) as ExistingBacktestResults;
  const updatedRigor = { ...(current.statistical_rigor ?? {}), deflated: payload };
  const updatedResults = { ...current, statistical_rigor: updatedRigor };
  const { error: e2 } = await supabase
    .from("algorithms")
    .update({ backtest_results: updatedResults as unknown as Database["public"]["Tables"]["algorithms"]["Update"]["backtest_results"] })
    .eq("id", row.id);
  if (e2) throw new Error(`Failed to update ${variantName}: ${e2.message}`);
}

async function main(): Promise<void> {
  const targetsEnv = (process.env.TARGETS ?? "").trim();
  if (!targetsEnv) {
    throw new Error(
      "TARGETS env var required. CSV of algo names to revalidate. Family for each is auto-derived from its name (split at ' | '). Example:\n" +
        '  TARGETS="LayerB: XAU/USD BOS-Long 4h | rr3_lb3_r06_rf0_af0" pnpm dlx tsx scripts/canonical/revalidate-candidates.ts',
    );
  }
  const targets = targetsEnv.split(",").map((s) => s.trim()).filter(Boolean);
  if (targets.length === 0) throw new Error("TARGETS contained no usable names.");

  console.log(`\n===== revalidate-candidates @ ${new Date().toISOString().slice(0, 16)} =====`);
  console.log(`Targets (${targets.length}):`);
  targets.forEach((t, i) => console.log(`  ${i + 1}. ${t}`));
  console.log(`NSPLITS=${NSPLITS} PERSIST=${PERSIST ? "1" : "0"}`);

  const { url, key } = requireEnv();
  const supabase = createClient<Database>(url, key);

  const familyPatterns: string[] = [];
  const targetToFamily = new Map<string, string>();
  for (let i = 0; i < targets.length; i++) {
    const fp = deriveFamilyPattern(targets[i], i + 1);
    targetToFamily.set(targets[i], fp);
    if (!familyPatterns.includes(fp)) familyPatterns.push(fp);
  }
  console.log(`Families (${familyPatterns.length}):`);
  familyPatterns.forEach((fp) => console.log(`  ${fp}`));

  const barsCache = new Map<string, PriceBar[]>();
  const familyData = new Map<string, VariantStats[]>();
  for (const fp of familyPatterns) {
    const stats = await runFamilyBacktests(supabase, fp, barsCache);
    familyData.set(fp, stats);
  }

  for (const target of targets) {
    const fp = targetToFamily.get(target);
    if (!fp) continue;
    const family = familyData.get(fp);
    if (!family) throw new Error(`Family data missing: ${fp}`);
    const variant = family.find((v) => v.name === target);
    if (!variant) {
      console.warn(`Target ${target} not found in family ${fp} — skipping`);
      continue;
    }

    const familySharpes = family.map((v) => v.sharpe);
    const trialSharpeStd = stdOf(familySharpes);
    const familySharpeMean = familySharpes.reduce((s, x) => s + x, 0) / familySharpes.length;
    const dsr = computeDeflatedSharpe({
      observedSharpe: variant.sharpe,
      returns: variant.perTradeR,
      nTrials: family.length,
      trialSharpeStd,
    });
    const returnsMatrix = family.map((v) => v.weeklyReturns);
    const pbo = computeProbabilityOfBacktestOverfitting({ returns: returnsMatrix, nSplits: NSPLITS });

    const { data: row, error } = await supabase
      .from("algorithms")
      .select("backtest_results")
      .eq("name", target)
      .maybeSingle();
    if (error) throw new Error(`Failed to read JSONB for ${target}: ${error.message}`);
    const existing = (row?.backtest_results ?? {}) as ExistingBacktestResults;
    const purgedKfold = existing.statistical_rigor?.purged_kfold ?? null;

    const payload: DeflatedStatsPayload = {
      computed_at: new Date().toISOString(),
      family_pattern: fp,
      family_size: family.length,
      family_trial_sharpe_std: trialSharpeStd,
      family_sharpe_mean: familySharpeMean,
      deflated_sharpe: dsr,
      pbo,
      purged_kfold_snapshot: purgedKfold,
    };

    if (PERSIST) await persistDeflated(supabase, target, payload);

    console.log(`\n[${target}]`);
    console.log(`  Observed Sharpe (per-trade):  ${variant.sharpe.toFixed(4)}`);
    console.log(`  Family Sharpe mean / std:     ${familySharpeMean.toFixed(4)} / ${trialSharpeStd.toFixed(4)}`);
    console.log(`  DSR / p-value:                ${dsr.deflatedSharpe.toFixed(4)} / ${dsr.pValueOneSided.toFixed(4)}`);
    console.log(`  Expected-max-SR:              ${dsr.expectedMaxSharpe.toFixed(4)}`);
    console.log(`  skewness / kurtosis:          ${dsr.skewness.toFixed(3)} / ${dsr.kurtosis.toFixed(3)}`);
    console.log(`  PBO:                          ${pbo.probabilityOfBacktestOverfitting.toFixed(4)} (N=${pbo.nStrategies}, T=${pbo.nObservations}, combos=${pbo.nCombinations})`);
    if (purgedKfold && typeof purgedKfold === "object") {
      const pk = purgedKfold as { consistency_count?: number; n_folds?: number; oos_mean_r_aggregate?: number };
      console.log(`  purged_kfold:                 ${pk.consistency_count ?? "?"}/${pk.n_folds ?? "?"} folds positive (aggregate R = ${(pk.oos_mean_r_aggregate ?? 0).toFixed(3)})`);
    } else {
      console.log(`  purged_kfold:                 missing (run validate-algo with KFOLD=N first)`);
    }
    if (!PERSIST) console.log(`  [PERSIST=0 → not written to DB]`);
  }

  console.log(`\nrevalidate-candidates complete. Inspect via:`);
  console.log(`  SELECT name, backtest_results->'statistical_rigor'->'deflated' FROM algorithms WHERE backtest_results->'statistical_rigor'->'deflated' IS NOT NULL;`);
}

main().catch((e) => {
  console.error(`revalidate-candidates FAILED: ${e instanceof Error ? e.message : String(e)}`);
  if (e instanceof Error && e.stack) console.error(e.stack);
  process.exit(1);
});
