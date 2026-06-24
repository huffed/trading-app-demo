/**
 * F2.4 — Alt objective function re-ranking.
 *
 * Re-ranks the candidate's family (default: 96-variant Engulfing-Long
 * Layer B family) under 3 alternative objective functions, then checks
 * whether the v3 survivor still ranks top-K under enough of them.
 *
 * Alt objectives (deliberately orthogonal to the primary DSR-by-Sharpe ranking):
 *   (a) Calmar         = total_R / max_drawdown_R
 *                        — penalises drawdown explicitly (DSR weights only Sharpe)
 *   (b) Trimmed-mean R = mean of per-trade R after removing top+bottom 10%
 *                        — penalises outlier dependence (1 lucky trade carrying the edge)
 *   (c) Recovery       = total_R / sum_of_drawdown_periods_R
 *                        — penalises time-in-drawdown (Calmar only cares about max DD)
 *
 * Gate (pre-registered):
 *   Survivor ranks top-K under ≥THRESHOLD/3 alt objectives.
 *   Defaults: TOP_K=3, GATE_THRESHOLD=2.
 *
 * Compute: 96 backtests × ~5s/each = ~8min wall-clock.
 *
 * Persists scripts/canonical/robustness-alt-objective-results.json with
 * full per-variant alt-objective scores + ranks + verdict for F2.5.
 *
 * Usage:
 *   pnpm dlx tsx scripts/canonical/robustness-alt-objective.ts
 *   FAMILY_PATTERN="LayerB: XAU/USD Engulfing-Long 4h | %" \
 *     SURVIVOR_TAG="rr3_lb6_r06_rf0_af0" \
 *     pnpm dlx tsx scripts/canonical/robustness-alt-objective.ts
 *
 * Env:
 *   FAMILY_PATTERN   default "LayerB: XAU/USD Engulfing-Long 4h | %" (SQL LIKE)
 *   SURVIVOR_TAG     default "rr3_lb6_r06_rf0_af0" (matches end of name)
 *   TOP_K            default 3
 *   GATE_THRESHOLD   default 2  (out of 3 alt objectives)
 *   OUTPUT_JSON      default scripts/canonical/robustness-alt-objective-results.json
 *   PERSIST          default 1  (set 0 for dry-run, print verdict + skip file write)
 */
import { readFileSync, writeFileSync } from "fs";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { timeframeToInterval } from "../../src/lib/market-data/interval";
import { runPortfolioBacktest } from "../../src/lib/market-data/portfolio-backtest";
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

const FAMILY_PATTERN =
  process.env.FAMILY_PATTERN ?? "LayerB: XAU/USD Engulfing-Long 4h | %";
const SURVIVOR_TAG = process.env.SURVIVOR_TAG ?? "rr3_lb6_r06_rf0_af0";
const TOP_K = Math.max(1, Number(process.env.TOP_K ?? 3));
const GATE_THRESHOLD = Math.max(1, Number(process.env.GATE_THRESHOLD ?? 2));
const OUTPUT_JSON =
  process.env.OUTPUT_JSON ?? "scripts/canonical/robustness-alt-objective-results.json";
const PERSIST = process.env.PERSIST !== "0";

function requireEnv(): { url: string; key: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error(
      "robustness-alt-objective requires NEXT_PUBLIC_SUPABASE_URL + " +
        "SUPABASE_SERVICE_ROLE_KEY (preferred) or NEXT_PUBLIC_SUPABASE_ANON_KEY in .env.local.",
    );
  }
  return { url, key };
}

function extractTicker(name: string): string {
  const noPrefix = name.replace(/^(Search|LayerB\+?):\s*/, "");
  const tokens = noPrefix.split(" ");
  return tokens[0] ?? "XAU/USD";
}

function extractTimeframe(name: string): string {
  // "LayerB: XAU/USD Engulfing-Long 4h | tag" → "4h"
  const match = name.match(/\s(\d+[mh])\s/);
  return match?.[1] ?? "4h";
}

function riskDollarsFor(rules: AlgorithmRules, capital: number): number {
  const sizing = rules.position_sizing;
  if (sizing?.type === "risk_per_trade") return capital * (sizing.value / 100);
  return capital * 0.01;
}

interface VariantRow {
  id: string;
  name: string;
  rules: AlgorithmRules;
  capital: number;
  ticker: string;
  timeframe: string;
}

interface VariantScores {
  name: string;
  is_survivor: boolean;
  total_r: number;
  trade_count: number;
  calmar: number;
  trimmed_mean_r: number;
  recovery_factor: number;
}

async function loadBars(
  supabase: SupabaseClient<Database>,
  ticker: string,
  timeframe: string,
  cache: Map<string, PriceBar[]>,
): Promise<PriceBar[]> {
  const key = `${ticker}|${timeframe}`;
  const cached = cache.get(key);
  if (cached) return cached;
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
    throw new Error(
      `No cached bars for ${ticker} ${interval}: ${error?.message ?? "row missing"}`,
    );
  }
  const bars = data.bars as unknown as PriceBar[];
  cache.set(key, bars);
  return bars;
}

/** Per-trade R-multiple series (PnL / riskDollars). */
function perTradeR(trades: readonly BacktestTrade[], riskDollars: number): number[] {
  if (riskDollars <= 0) return [];
  return trades.map((t) => t.pnl / riskDollars);
}

/** Total R. */
function totalR(trades: readonly BacktestTrade[], riskDollars: number): number {
  return perTradeR(trades, riskDollars).reduce((a, b) => a + b, 0);
}

/** Max-drawdown computed on cumulative R-equity. Returns the max peak-to-
 *  trough drop expressed in R units (≥ 0). */
function maxDrawdownR(trades: readonly BacktestTrade[], riskDollars: number): number {
  const rSeries = perTradeR(trades, riskDollars);
  if (rSeries.length === 0) return 0;
  let peak = 0;
  let equity = 0;
  let maxDd = 0;
  for (const r of rSeries) {
    equity += r;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDd) maxDd = dd;
  }
  return maxDd;
}

/** Sum of all drawdown-period R (cumulative R loss across every drawdown
 *  episode, not just the worst). Used by Recovery Factor. */
function sumDrawdownR(trades: readonly BacktestTrade[], riskDollars: number): number {
  const rSeries = perTradeR(trades, riskDollars);
  if (rSeries.length === 0) return 0;
  let peak = 0;
  let equity = 0;
  let totalDd = 0;
  for (const r of rSeries) {
    equity += r;
    if (equity > peak) peak = equity;
    totalDd += peak - equity;
  }
  return totalDd;
}

/** Trimmed-mean R: drop top + bottom `trimFraction` from the sorted R
 *  series, take mean of the remainder. Defaults to 10% per side. Empty
 *  result → 0. */
function trimmedMeanR(
  trades: readonly BacktestTrade[],
  riskDollars: number,
  trimFraction = 0.1,
): number {
  const rSeries = perTradeR(trades, riskDollars);
  if (rSeries.length === 0) return 0;
  const sorted = [...rSeries].sort((a, b) => a - b);
  const dropEachSide = Math.floor(sorted.length * trimFraction);
  const kept = sorted.slice(dropEachSide, sorted.length - dropEachSide);
  if (kept.length === 0) return 0;
  return kept.reduce((a, b) => a + b, 0) / kept.length;
}

/** Calmar in R units. Returns Infinity for max_dd=0 (no DD → undefined ratio); call site
 *  caller handles via rank tie-break (Infinity sorts to top, consistent with intent).
 *  Returns 0 when total_R ≤ 0 AND max_dd = 0 (degenerate / no trades). */
function calmarR(trades: readonly BacktestTrade[], riskDollars: number): number {
  const tr = totalR(trades, riskDollars);
  const dd = maxDrawdownR(trades, riskDollars);
  if (dd === 0) {
    if (tr <= 0) return 0;
    return Number.POSITIVE_INFINITY;
  }
  return tr / dd;
}

/** Recovery Factor = total_R / sum_drawdown_R. Same edge-case handling as
 *  calmarR. Captures "how much profit per unit of time-in-drawdown",
 *  whereas Calmar only weights the SINGLE WORST drawdown. */
function recoveryFactor(trades: readonly BacktestTrade[], riskDollars: number): number {
  const tr = totalR(trades, riskDollars);
  const dds = sumDrawdownR(trades, riskDollars);
  if (dds === 0) {
    if (tr <= 0) return 0;
    return Number.POSITIVE_INFINITY;
  }
  return tr / dds;
}

async function main(): Promise<void> {
  const { url, key } = requireEnv();
  const supabase = createClient<Database>(url, key);

  console.log(`F2.4 alt-objective re-ranking`);
  console.log(`  family : ${FAMILY_PATTERN}`);
  console.log(`  survivor tag : ${SURVIVOR_TAG}`);
  console.log(`  top-K : ${TOP_K}`);
  console.log(`  gate threshold : ${GATE_THRESHOLD}/3`);
  console.log("");

  const { data: rows, error } = await supabase
    .from("algorithms")
    .select("id, name, rules, capital")
    .like("name", FAMILY_PATTERN);
  if (error) throw new Error(`Failed to fetch family: ${error.message}`);
  if (!rows || rows.length === 0) {
    throw new Error(`No rows match family pattern '${FAMILY_PATTERN}'`);
  }
  console.log(`Loaded ${rows.length} family variants from DB`);

  const variants: VariantRow[] = rows.map((r) => ({
    id: r.id,
    name: r.name,
    rules: r.rules as unknown as AlgorithmRules,
    capital: Number(r.capital),
    ticker: extractTicker(r.name),
    timeframe: extractTimeframe(r.name),
  }));

  const barsCache = new Map<string, PriceBar[]>();
  const scores: VariantScores[] = [];

  let processed = 0;
  for (const v of variants) {
    processed++;
    const isSurvivor = v.name.endsWith(`| ${SURVIVOR_TAG}`);
    const bars = await loadBars(supabase, v.ticker, v.timeframe, barsCache);
    const pricesByTicker = new Map<string, PriceBar[]>([[v.ticker.toUpperCase(), bars]]);
    const result = runPortfolioBacktest(v.rules, pricesByTicker, v.capital);
    const trades = result.trades ?? [];
    const riskDollars = riskDollarsFor(v.rules, v.capital);

    scores.push({
      name: v.name,
      is_survivor: isSurvivor,
      total_r: totalR(trades, riskDollars),
      trade_count: trades.length,
      calmar: calmarR(trades, riskDollars),
      trimmed_mean_r: trimmedMeanR(trades, riskDollars, 0.1),
      recovery_factor: recoveryFactor(trades, riskDollars),
    });

    if (processed % 10 === 0 || processed === variants.length) {
      console.log(`  progress: ${processed}/${variants.length}`);
    }
  }

  // Rank by each objective (descending; ties broken by total_r descending).
  function rankBy(key: "calmar" | "trimmed_mean_r" | "recovery_factor"): Array<{ name: string; rank: number; score: number }> {
    const sorted = [...scores].sort((a, b) => {
      if (a[key] === b[key]) return b.total_r - a.total_r;
      return b[key] - a[key];
    });
    return sorted.map((s, i) => ({ name: s.name, rank: i + 1, score: s[key] }));
  }

  const calmarRank = rankBy("calmar");
  const trimmedRank = rankBy("trimmed_mean_r");
  const recoveryRank = rankBy("recovery_factor");

  function survivorRank(ranks: typeof calmarRank): number {
    const r = ranks.find((x) => x.name.endsWith(`| ${SURVIVOR_TAG}`));
    return r?.rank ?? -1;
  }

  const calmarSurvivorRank = survivorRank(calmarRank);
  const trimmedSurvivorRank = survivorRank(trimmedRank);
  const recoverySurvivorRank = survivorRank(recoveryRank);

  const passes = {
    calmar: calmarSurvivorRank > 0 && calmarSurvivorRank <= TOP_K,
    trimmed_mean_r: trimmedSurvivorRank > 0 && trimmedSurvivorRank <= TOP_K,
    recovery_factor: recoverySurvivorRank > 0 && recoverySurvivorRank <= TOP_K,
  };
  const passCount = (passes.calmar ? 1 : 0) + (passes.trimmed_mean_r ? 1 : 0) + (passes.recovery_factor ? 1 : 0);
  const verdict: "PASS" | "FAIL" = passCount >= GATE_THRESHOLD ? "PASS" : "FAIL";

  const top3 = (ranks: typeof calmarRank): Array<{ name: string; rank: number; score: number }> => ranks.slice(0, 3);
  const survivorScore = scores.find((s) => s.is_survivor) ?? null;

  console.log("");
  console.log(`F2.4 ALT-OBJECTIVE VERDICT: ${verdict} (${passCount}/${GATE_THRESHOLD} passes)`);
  console.log(`  survivor rank by Calmar           : ${calmarSurvivorRank} ${passes.calmar ? "✓" : "✗"} (score ${survivorScore?.calmar.toFixed(4) ?? "—"})`);
  console.log(`  survivor rank by Trimmed mean R   : ${trimmedSurvivorRank} ${passes.trimmed_mean_r ? "✓" : "✗"} (score ${survivorScore?.trimmed_mean_r.toFixed(4) ?? "—"})`);
  console.log(`  survivor rank by Recovery Factor  : ${recoverySurvivorRank} ${passes.recovery_factor ? "✓" : "✗"} (score ${survivorScore?.recovery_factor.toFixed(4) ?? "—"})`);

  const output = {
    sub_gate: "F2.4 alt-objective" as const,
    verdict,
    pass_count: passCount,
    gate_threshold: GATE_THRESHOLD,
    top_k: TOP_K,
    family_pattern: FAMILY_PATTERN,
    survivor_tag: SURVIVOR_TAG,
    survivor_score: survivorScore,
    ranks_by_objective: {
      calmar: { survivor_rank: calmarSurvivorRank, passes: passes.calmar, top_3: top3(calmarRank) },
      trimmed_mean_r: { survivor_rank: trimmedSurvivorRank, passes: passes.trimmed_mean_r, top_3: top3(trimmedRank) },
      recovery_factor: { survivor_rank: recoverySurvivorRank, passes: passes.recovery_factor, top_3: top3(recoveryRank) },
    },
    full_scores: scores,
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
