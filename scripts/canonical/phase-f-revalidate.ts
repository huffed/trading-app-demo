/**
 * Phase F.4 (ROADMAP.md) — re-evaluate the 3 candidate variants under v3
 * methodology: Deflated Sharpe Ratio + Probability of Backtest Overfitting
 * + (already-persisted) purged k-fold CV.
 *
 * Why a separate script (not modify validate-algo):
 *   - validate-algo evaluates ONE algo at a time; DSR + PBO require
 *     CROSS-SIBLING data (the family of 96 Layer B variants per base).
 *   - Re-running portfolio-backtest for all 192 variants (2 bases × 96)
 *     captures the per-trade returns needed for DSR (skewness/kurtosis)
 *     + the per-period returns needed for PBO (CSCV matrix).
 *   - validate-algo's existing PERSIST=1 KFOLD=5 invocation handles the
 *     purged_kfold sub-block; this script reads it back from JSONB.
 *
 * Persistence: writes `statistical_rigor.deflated` sub-block to each of
 * the 3 SELECTED variants' `algorithms.backtest_results` JSONB. Idempotent
 * — re-running overwrites the deflated block with fresh stats.
 *
 * Wall clock: ~16 minutes for 192 backtests at ~5s each (gold 4h ~6yr).
 * Run as: `pnpm dlx tsx scripts/canonical/phase-f-revalidate.ts`
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

/** The 3 v3-evaluation targets per ROADMAP.md F.4. Each is the
 *  Calmar-best variant of its respective base from the Layer B sweep. */
const TARGETS = [
  {
    variant_name: "LayerB: XAU/USD Engulfing-Long 4h | rr3_lb6_r06_rf0_af0",
    family_prefix: "LayerB: XAU/USD Engulfing-Long 4h | ",
  },
  {
    variant_name: "LayerB: XAU/USD Engulfing-Long 4h | rr5_lb6_r1_rf0_af0",
    family_prefix: "LayerB: XAU/USD Engulfing-Long 4h | ",
  },
  {
    variant_name: "LayerB: XAU/USD BOS-Long 4h | rr3_lb3_r06_rf0_af0",
    family_prefix: "LayerB: XAU/USD BOS-Long 4h | ",
  },
] as const;

const N_SPLITS = 8;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

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
  weeklyReturns: number[]; // common time grid for PBO matrix
  riskDollars: number;
}

function requireEnv(): { url: string; key: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error(
      "phase-f-revalidate requires NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (preferred) " +
      "or NEXT_PUBLIC_SUPABASE_ANON_KEY in .env.local.",
    );
  }
  return { url, key };
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

/** Build per-week R series for a variant's trades. Common time grid is
 *  computed once across the family + passed in so all variants align. */
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
  if (sizing?.type === "risk_per_trade") {
    return capital * (sizing.value / 100);
  }
  // Fall back to 1% if not risk_per_trade (rare in our v2 enumerator).
  return capital * 0.01;
}

async function runFamilyBacktests(
  supabase: SupabaseClient<Database>,
  familyPrefix: string,
  bars: PriceBar[],
): Promise<VariantStats[]> {
  const { data: rows, error } = await supabase
    .from("algorithms")
    .select("id, name, rules, capital")
    .like("name", `${familyPrefix}%`);
  if (error) throw new Error(`Failed to fetch family ${familyPrefix}: ${error.message}`);
  if (!rows || rows.length === 0) throw new Error(`No rows for family ${familyPrefix}`);

  const variants: VariantRow[] = rows.map((r) => ({
    id: r.id,
    name: r.name,
    rules: r.rules as unknown as AlgorithmRules,
    capital: Number(r.capital),
  }));

  console.log(`\n[${familyPrefix}] ${variants.length} variants → running backtests...`);

  const pricesByTicker = new Map([["XAU/USD", bars]]);

  // First pass: run backtests, collect trades + sharpe.
  const partial: Array<Omit<VariantStats, "weeklyReturns"> & { entryMin: number; exitMax: number }> = [];
  for (let i = 0; i < variants.length; i++) {
    const v = variants[i];
    const metrics = runPortfolioBacktest(v.rules, pricesByTicker, v.capital);
    // BacktestMetrics has `trades: BacktestTrade[]` at top level. The
    // per_ticker[].trades field is a COUNT (number), not an array — don't
    // use it for trade-level analysis.
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
      console.log(`  [${familyPrefix}] ${i + 1}/${variants.length} backtested`);
    }
  }

  // Second pass: build common time grid + per-week R per variant.
  // Use the global min entry / max exit across all variants so the grid covers everything.
  let globalMin = Infinity;
  let globalMax = -Infinity;
  for (const p of partial) {
    if (Number.isFinite(p.entryMin) && p.entryMin < globalMin) globalMin = p.entryMin;
    if (Number.isFinite(p.exitMax) && p.exitMax > globalMax) globalMax = p.exitMax;
  }
  if (!Number.isFinite(globalMin) || !Number.isFinite(globalMax)) {
    throw new Error(`Family ${familyPrefix} produced no trades across any variant; can't compute PBO grid.`);
  }
  const weekCount = Math.ceil((globalMax - globalMin) / WEEK_MS) + 1;
  console.log(`  [${familyPrefix}] time grid: ${weekCount} weeks (${new Date(globalMin).toISOString().slice(0, 10)} → ${new Date(globalMax).toISOString().slice(0, 10)})`);

  return partial.map((p) => ({
    name: p.name,
    trades: p.trades,
    sharpe: p.sharpe,
    perTradeR: p.perTradeR,
    weeklyReturns: buildWeeklyReturns(p.trades, p.riskDollars, globalMin, weekCount),
    riskDollars: p.riskDollars,
  }));
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

interface PersistedDeflated {
  computed_at: string;
  family_prefix: string;
  family_size: number;
  family_trial_sharpe_std: number;
  family_sharpe_mean: number;
  deflated_sharpe: DeflatedSharpeResult;
  pbo: PboResult;
  /** Cached snapshot of statistical_rigor.purged_kfold at compute time
   *  (the source-of-truth lives in the same JSONB, but having it inline
   *  keeps the v3 acceptance verdict reproducible from a single read). */
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
  payload: PersistedDeflated,
): Promise<void> {
  const { data: row, error } = await supabase
    .from("algorithms")
    .select("id, backtest_results")
    .eq("name", variantName)
    .maybeSingle();
  if (error) throw new Error(`Failed to fetch ${variantName} for persist: ${error.message}`);
  if (!row) throw new Error(`Row not found: ${variantName}`);

  const current = (row.backtest_results ?? {}) as ExistingBacktestResults;
  const updatedRigor = {
    ...(current.statistical_rigor ?? {}),
    deflated: payload,
  };
  const updatedResults = {
    ...current,
    statistical_rigor: updatedRigor,
  };

  const { error: e2 } = await supabase
    .from("algorithms")
    .update({ backtest_results: updatedResults as unknown as Database["public"]["Tables"]["algorithms"]["Update"]["backtest_results"] })
    .eq("id", row.id);
  if (e2) throw new Error(`Failed to update ${variantName}: ${e2.message}`);
}

async function main(): Promise<void> {
  console.log(`\n===== Phase F.4 revalidate @ ${new Date().toISOString().slice(0, 16)} =====`);
  const { url, key } = requireEnv();
  const supabase = createClient<Database>(url, key);

  const bars = await loadBars(supabase, "XAU/USD", "4h");
  console.log(`Loaded ${bars.length} XAU/USD 4h bars`);

  // Group targets by family to share backtest work.
  const familyPrefixes = [...new Set(TARGETS.map((t) => t.family_prefix))];
  const familyData = new Map<string, VariantStats[]>();
  for (const prefix of familyPrefixes) {
    const stats = await runFamilyBacktests(supabase, prefix, bars);
    familyData.set(prefix, stats);
  }

  // Process each target: compute DSR + look up family PBO + read kfold from JSONB.
  for (const target of TARGETS) {
    const family = familyData.get(target.family_prefix);
    if (!family) throw new Error(`Family data missing: ${target.family_prefix}`);
    const variant = family.find((v) => v.name === target.variant_name);
    if (!variant) throw new Error(`Target ${target.variant_name} not in family ${target.family_prefix}`);

    // DSR: observedSharpe = variant.sharpe; trialSharpeStd = std of family sharpes.
    const familySharpes = family.map((v) => v.sharpe);
    const trialSharpeStd = stdOf(familySharpes);
    const familySharpeMean = familySharpes.reduce((s, x) => s + x, 0) / familySharpes.length;
    const dsr = computeDeflatedSharpe({
      observedSharpe: variant.sharpe,
      returns: variant.perTradeR,
      nTrials: family.length,
      trialSharpeStd,
    });

    // PBO: weekly returns matrix across all family variants.
    const returnsMatrix = family.map((v) => v.weeklyReturns);
    const pbo = computeProbabilityOfBacktestOverfitting({
      returns: returnsMatrix,
      nSplits: N_SPLITS,
    });

    // Read existing purged_kfold from JSONB (populated by prior validate-algo KFOLD=5 run).
    const { data: row, error } = await supabase
      .from("algorithms")
      .select("backtest_results")
      .eq("name", target.variant_name)
      .maybeSingle();
    if (error) throw new Error(`Failed to read JSONB for ${target.variant_name}: ${error.message}`);
    const existing = (row?.backtest_results ?? {}) as ExistingBacktestResults;
    const purgedKfold = existing.statistical_rigor?.purged_kfold ?? null;

    const payload: PersistedDeflated = {
      computed_at: new Date().toISOString(),
      family_prefix: target.family_prefix,
      family_size: family.length,
      family_trial_sharpe_std: trialSharpeStd,
      family_sharpe_mean: familySharpeMean,
      deflated_sharpe: dsr,
      pbo,
      purged_kfold_snapshot: purgedKfold,
    };

    await persistDeflated(supabase, target.variant_name, payload);

    console.log(`\n[${target.variant_name}]`);
    console.log(`  Observed Sharpe (per-trade):  ${variant.sharpe.toFixed(4)}`);
    console.log(`  Family Sharpe mean / std:     ${familySharpeMean.toFixed(4)} / ${trialSharpeStd.toFixed(4)}`);
    console.log(`  DSR / p-value:                ${dsr.deflatedSharpe.toFixed(4)} / ${dsr.pValueOneSided.toFixed(4)}`);
    console.log(`  Expected-max-SR (selection-bias):  ${dsr.expectedMaxSharpe.toFixed(4)}`);
    console.log(`  skewness / kurtosis:          ${dsr.skewness.toFixed(3)} / ${dsr.kurtosis.toFixed(3)}`);
    console.log(`  PBO:                          ${pbo.probabilityOfBacktestOverfitting.toFixed(4)} (N=${pbo.nStrategies}, T=${pbo.nObservations}, combos=${pbo.nCombinations})`);
    if (purgedKfold && typeof purgedKfold === "object") {
      const pk = purgedKfold as { consistency_count?: number; n_folds?: number; oos_mean_r_aggregate?: number };
      console.log(`  purged_kfold:                 ${pk.consistency_count ?? "?"}/${pk.n_folds ?? "?"} folds positive (aggregate R = ${(pk.oos_mean_r_aggregate ?? 0).toFixed(3)})`);
    } else {
      console.log(`  purged_kfold:                 missing (run validate-algo with KFOLD=5 first)`);
    }
  }

  console.log(`\nPhase F.4 complete. Inspect via:`);
  console.log(`  SELECT name, backtest_results->'statistical_rigor'->'deflated' FROM algorithms WHERE name LIKE 'LayerB:%' AND backtest_results->'statistical_rigor'->'deflated' IS NOT NULL;`);
}

main().catch((e) => {
  console.error(`Phase F.4 FAILED: ${e instanceof Error ? e.message : String(e)}`);
  if (e instanceof Error && e.stack) console.error(e.stack);
  process.exit(1);
});
