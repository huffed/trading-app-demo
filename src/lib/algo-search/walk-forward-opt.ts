/**
 * Walk-forward optimization (G.5) — monthly re-fit of an algo's Layer B
 * geometry on a rolling 12-month window.
 *
 * Implements REV 2 + REV 4 of `scripts/canonical/ROADMAP.md`:
 *   - REV 2: Layer B becomes diagnostic-only / one-time exploration; this
 *     module is the PRODUCTION parameter mechanism going forward.
 *   - REV 4: static parameter deployment → walk-forward-optimized
 *     deployment. The algo's pre-registration entry should describe
 *     this WFO process as the deployment model (per-cycle parameter
 *     updates are within-process, not new registrations).
 *
 * Algorithm:
 *   1. Extract current Layer B geometry from algo.rules. If the algo
 *      doesn't fit the Layer B template (e.g. uses vol_target sizing,
 *      non-swing_anchor SL), skip with a clear reason.
 *   2. Slice the cached bars to the rolling 12-month window ending now.
 *   3. Enumerate 96 Layer B variants from the same base.
 *   4. Run portfolio-backtest on each variant against the windowed bars.
 *   5. Compute Sharpe + per-trade R series for each.
 *   6. Compute DSR for the BEST variant (selection-bias-aware, using
 *      family Sharpe std as nTrials denominator).
 *   7. Compare best DSR to the algo's CURRENT geometry DSR in the same
 *      window. If best > current + buffer (default 0.05) AND best
 *      geometry differs from current, propose update.
 *   8. DRY_RUN=1 (default) → just return proposals + log. DRY_RUN=0 →
 *      UPDATE algorithms.rules + write wfo_rules_updated audit event.
 *
 * Operator-facing flow:
 *   - First 2-3 monthly cycles run in DRY_RUN=1 to verify parameters
 *     don't flap month-to-month (the gate).
 *   - Once stable, operator flips to DRY_RUN=0 in crontab.
 *   - Each apply writes an audit event with before/after geometry + DSR
 *     delta so the operator can review live mutations.
 */
import { runPortfolioBacktest } from "@/lib/market-data/portfolio-backtest";
import type { PriceBar } from "@/lib/market-data/types";
import { computeDeflatedSharpe } from "@/lib/stats/deflated-sharpe";
import type { AlgorithmRules } from "@/types/algorithm";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  enumerateLayerBVariants,
  geometryTag,
  RR_MULTIPLES,
  SL_LOOKBACKS,
  RISK_PCTS,
  layerBCardinality,
  type LayerBGeometry,
} from "./layer-b-enumerate";

export const DEFAULT_WFO_CONFIG: Required<WfoConfig> = {
  window_days: 365,
  dsr_improvement_buffer: 0.05,
};

export interface WfoConfig {
  window_days?: number;
  dsr_improvement_buffer?: number;
}

export type WfoSkipReason =
  | "no_layer_b_geometry" // rules don't fit Layer B template
  | "no_bars_cached" // ticker × timeframe missing from price_cache
  | "insufficient_window_data" // < 2 trades across all variants in window
  | "no_baseline_in_window" // current geometry produced 0 trades
  | "no_improvement"; // best DSR didn't exceed current + buffer

export interface WfoProposal {
  algorithm_id: string;
  algorithm_name: string;
  current_geometry: LayerBGeometry | null;
  current_dsr: number | null;
  best_geometry: LayerBGeometry;
  best_dsr: number;
  family_sharpe_std: number;
  family_size: number;
  /** dsr improvement = best_dsr − (current_dsr ?? 0). */
  dsr_improvement: number;
  passes_buffer: boolean;
  rules_changed: boolean;
  proposed_rules: AlgorithmRules;
  trades_in_window: number;
  window_start: string;
  window_end: string;
}

export interface WfoSkip {
  algorithm_id: string;
  algorithm_name: string;
  reason: WfoSkipReason;
  detail: string;
}

/** Extract the canonical 5-axis Layer B geometry from existing rules,
 *  if the rules shape matches. Returns null when ANY axis can't be
 *  read — this signals an algo whose live geometry is outside the
 *  Layer B grid (e.g. vol_target sizing, percentage SL instead of
 *  swing_anchor, non-rr_multiple TP). Those algos are SKIPPED by WFO,
 *  not silently snapped to the grid. */
export function extractCurrentGeometry(rules: AlgorithmRules): LayerBGeometry | null {
  const sl = rules.stop_loss as { type?: string; lookback?: number };
  const tp = rules.take_profit as { type?: string; value?: number };
  const sizing = rules.position_sizing;
  if (sl?.type !== "swing_anchor" || typeof sl.lookback !== "number") return null;
  if (tp?.type !== "rr_multiple" || typeof tp.value !== "number") return null;
  if (sizing.type !== "risk_per_trade") return null;
  const rr = tp.value;
  const lb = sl.lookback;
  const risk = sizing.value;
  if (!(RR_MULTIPLES as readonly number[]).includes(rr)) return null;
  if (!(SL_LOOKBACKS as readonly number[]).includes(lb)) return null;
  if (!(RISK_PCTS as readonly number[]).includes(risk)) return null;
  return {
    rr_multiple: rr as LayerBGeometry["rr_multiple"],
    sl_lookback: lb as LayerBGeometry["sl_lookback"],
    risk_per_trade_pct: risk as LayerBGeometry["risk_per_trade_pct"],
    regime_filter: Boolean((rules as { regime_filter?: { enabled?: boolean } }).regime_filter?.enabled),
    adx_filter: Boolean((rules as { adx_filter?: { enabled?: boolean } }).adx_filter?.enabled),
  };
}

/** Filter bars to the rolling window [now - window_days, now]. Both ends
 *  inclusive. Returns a shallow copy. */
export function sliceBarsToWindow(
  bars: readonly PriceBar[],
  windowDays: number,
  now: Date,
): PriceBar[] {
  const cutoffMs = now.getTime() - windowDays * 86_400_000;
  return bars.filter((b) => new Date(b.date).getTime() >= cutoffMs);
}

function meanOf(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

function stdOf(xs: readonly number[]): number {
  if (xs.length < 2) return 0;
  const m = meanOf(xs);
  let v = 0;
  for (const x of xs) v += (x - m) * (x - m);
  return Math.sqrt(v / xs.length);
}

function sharpeFromR(rs: readonly number[]): number {
  if (rs.length < 2) return 0;
  const mean = meanOf(rs);
  const sd = stdOf(rs);
  return sd === 0 ? 0 : mean / sd;
}

interface VariantResult {
  geometry: LayerBGeometry;
  rules: AlgorithmRules;
  trades: number;
  sharpe: number;
  perTradeR: number[];
}

interface AlgoRow {
  id: string;
  name: string;
  user_id: string;
  capital: number;
  rules: AlgorithmRules;
  watchlist_tickers: string[];
}

/** Pure-ish — given an algo + cached bars + 96 enumerated variants, run
 *  each backtest on the windowed bars + return results. Caller handles
 *  DSR + persistence. */
function runVariantSweep(
  algo: AlgoRow,
  windowedBarsByTicker: Map<string, PriceBar[]>,
): VariantResult[] {
  const variants = enumerateLayerBVariants({
    name: `Search: ${algo.name.replace(/^LayerB:\s*/, "").split(" | ")[0]}`,
    ticker: algo.watchlist_tickers[0] ?? "",
    capital: algo.capital,
    rules: algo.rules,
  });
  const out: VariantResult[] = [];
  // Risk dollars (assumes risk_per_trade sizing). vol_target / lots fall
  // outside Layer B per extractCurrentGeometry; we only enter this loop
  // after that check passed.
  const baseRiskPct = (algo.rules.position_sizing as { value: number }).value;
  for (const v of variants) {
    const metrics = runPortfolioBacktest(v.rules, windowedBarsByTicker, algo.capital);
    const trades = metrics.trades ?? [];
    // Per-variant risk dollars (sizing.value may differ from base due to
    // the risk_per_trade axis).
    const variantRiskPct = (v.rules.position_sizing as { value: number }).value ?? baseRiskPct;
    const riskDollars = algo.capital * (variantRiskPct / 100);
    const perTradeR = riskDollars > 0 ? trades.map((t) => t.pnl / riskDollars) : [];
    const sharpe = sharpeFromR(perTradeR);
    out.push({
      geometry: v.geometry,
      rules: v.rules,
      trades: trades.length,
      sharpe,
      perTradeR,
    });
  }
  return out;
}

/** Identify the variant whose geometry equals `target` (deep equality on
 *  the 5 axes). Returns null if not found (shouldn't happen — the 96-grid
 *  is exhaustive over Layer B). */
function findVariantByGeometry(
  variants: VariantResult[],
  target: LayerBGeometry,
): VariantResult | null {
  return variants.find((v) =>
    v.geometry.rr_multiple === target.rr_multiple &&
    v.geometry.sl_lookback === target.sl_lookback &&
    v.geometry.risk_per_trade_pct === target.risk_per_trade_pct &&
    v.geometry.regime_filter === target.regime_filter &&
    v.geometry.adx_filter === target.adx_filter,
  ) ?? null;
}

function geometryEquals(a: LayerBGeometry, b: LayerBGeometry): boolean {
  return geometryTag(a) === geometryTag(b);
}

export interface WfoComputeContext {
  /** Map<ticker, full bars> — caller provides cached bars. WFO slices
   *  internally to the rolling window. */
  barsByTicker: Map<string, PriceBar[]>;
  config?: Required<WfoConfig>;
  now?: Date;
}

/** Compute the WFO proposal for one algo. Pure-ish — no DB writes; only
 *  reads from the supplied bars cache. Returns either a WfoProposal
 *  (with passes_buffer flag that callers gate the UPDATE on) OR a
 *  WfoSkip explaining why the algo couldn't be evaluated. */
export function computeWfoProposal(
  algo: AlgoRow,
  ctx: WfoComputeContext,
): WfoProposal | WfoSkip {
  const config = ctx.config ?? DEFAULT_WFO_CONFIG;
  const now = ctx.now ?? new Date();

  // Step 1: extract current geometry — gates on Layer B template fit
  const current = extractCurrentGeometry(algo.rules);
  if (!current) {
    return {
      algorithm_id: algo.id,
      algorithm_name: algo.name,
      reason: "no_layer_b_geometry",
      detail: "Algo rules don't fit Layer B template (swing_anchor SL + rr_multiple TP + risk_per_trade sizing + grid-valued geometry)",
    };
  }

  // Step 2: window the bars (assume single-ticker algo per current Phase E
  // shape — multi-ticker is Phase I.4 territory).
  const ticker = algo.watchlist_tickers[0];
  if (!ticker) {
    return {
      algorithm_id: algo.id,
      algorithm_name: algo.name,
      reason: "no_bars_cached",
      detail: "Algo has no watchlist ticker",
    };
  }
  const fullBars = ctx.barsByTicker.get(ticker);
  if (!fullBars || fullBars.length === 0) {
    return {
      algorithm_id: algo.id,
      algorithm_name: algo.name,
      reason: "no_bars_cached",
      detail: `No bars cached for ${ticker}`,
    };
  }
  const windowedBars = sliceBarsToWindow(fullBars, config.window_days, now);
  const windowStart = windowedBars[0]?.date ?? "";
  const windowEnd = windowedBars[windowedBars.length - 1]?.date ?? "";
  const windowedByTicker = new Map<string, PriceBar[]>([[ticker, windowedBars]]);

  // Step 3-5: run 96-variant sweep on windowed bars
  const variants = runVariantSweep(algo, windowedByTicker);
  const totalTrades = variants.reduce((s, v) => s + v.trades, 0);
  if (totalTrades < 2) {
    return {
      algorithm_id: algo.id,
      algorithm_name: algo.name,
      reason: "insufficient_window_data",
      detail: `Only ${totalTrades} trades across all 96 variants in ${config.window_days}d window`,
    };
  }

  // Step 6: locate current + best, compute DSR for both using same
  // family Sharpe std (selection bias is identical for both).
  const familySharpes = variants.map((v) => v.sharpe);
  const familySharpeStd = stdOf(familySharpes);
  const familySize = variants.length || layerBCardinality();

  const currentVariant = findVariantByGeometry(variants, current);
  const currentDsr = currentVariant && currentVariant.perTradeR.length >= 2
    ? computeDeflatedSharpe({
        observedSharpe: currentVariant.sharpe,
        returns: currentVariant.perTradeR,
        nTrials: familySize,
        trialSharpeStd: familySharpeStd,
      }).deflatedSharpe
    : null;

  // Best variant by raw Sharpe first (we'll then compute DSR for it).
  // Selecting on raw sharpe matches the "best-by-DSR after selection
  // correction" convention — DSR ranking on the family is equivalent
  // because each variant gets the same nTrials + trialSharpeStd.
  const bestVariant = [...variants].sort((a, b) => b.sharpe - a.sharpe)[0];
  const bestDsrResult = bestVariant.perTradeR.length >= 2
    ? computeDeflatedSharpe({
        observedSharpe: bestVariant.sharpe,
        returns: bestVariant.perTradeR,
        nTrials: familySize,
        trialSharpeStd: familySharpeStd,
      })
    : null;
  const bestDsr = bestDsrResult?.deflatedSharpe ?? 0;

  // Step 7: gating
  const dsrImprovement = bestDsr - (currentDsr ?? 0);
  const passesBuffer = dsrImprovement > config.dsr_improvement_buffer;
  const rulesChanged = !geometryEquals(bestVariant.geometry, current);

  return {
    algorithm_id: algo.id,
    algorithm_name: algo.name,
    current_geometry: current,
    current_dsr: currentDsr,
    best_geometry: bestVariant.geometry,
    best_dsr: bestDsr,
    family_sharpe_std: familySharpeStd,
    family_size: familySize,
    dsr_improvement: dsrImprovement,
    passes_buffer: passesBuffer,
    rules_changed: rulesChanged,
    proposed_rules: bestVariant.rules,
    trades_in_window: totalTrades,
    window_start: windowStart,
    window_end: windowEnd,
  };
}

export interface AppliedWfoUpdate {
  algorithm_id: string;
  algorithm_name: string;
  before_geometry: LayerBGeometry;
  after_geometry: LayerBGeometry;
  before_dsr: number | null;
  after_dsr: number;
  dsr_improvement: number;
}

export interface EvaluateAndApplyWfoResult {
  generated_at: string;
  dry_run: boolean;
  evaluated: number;
  proposals: WfoProposal[];
  skipped: WfoSkip[];
  /** Algos whose rules were UPDATEd on this run. Empty when dry_run=true. */
  applied: AppliedWfoUpdate[];
}

interface DbAlgoRow {
  id: string;
  name: string;
  user_id: string;
  capital: number;
  rules: AlgorithmRules;
  algorithm_watchlist?: { ticker: string }[] | null;
}

/** Load bars for a ticker × timeframe from the price_cache table. */
async function loadCachedBars(
  supabase: SupabaseClient,
  ticker: string,
  interval: string,
): Promise<PriceBar[] | null> {
  const { data, error } = await supabase
    .from("price_cache")
    .select("bars")
    .eq("ticker", ticker.toUpperCase())
    .eq("output_size", "full")
    .eq("interval", interval)
    .limit(1)
    .single();
  if (error && error.code !== "PGRST116") {
    throw new Error(`loadCachedBars ${ticker} ${interval}: ${error.message}`);
  }
  return (data?.bars as PriceBar[] | null) ?? null;
}

/** Cron entry point. Iterates every active algo, computes WFO proposal,
 *  and (when dry_run=false) applies the UPDATE + writes the audit event.
 *  Returns a full report so the cron route can surface it. */
export async function evaluateAndApplyWfo(
  supabase: SupabaseClient,
  opts: { dry_run: boolean; config?: Required<WfoConfig> } = { dry_run: true },
  now: Date = new Date(),
): Promise<EvaluateAndApplyWfoResult> {
  const config = opts.config ?? DEFAULT_WFO_CONFIG;
  const { data: algos, error } = await supabase
    .from("algorithms")
    .select("id, name, user_id, capital, rules, algorithm_watchlist(ticker)")
    .eq("status", "active");
  if (error) throw new Error(`wfo algorithms query failed: ${error.message}`);
  const rows = (algos ?? []) as DbAlgoRow[];

  const proposals: WfoProposal[] = [];
  const skipped: WfoSkip[] = [];
  const applied: AppliedWfoUpdate[] = [];
  // Lazy-loaded bars cache keyed by ticker|interval; one DB hit per
  // unique (ticker, interval) combination across the active fleet.
  const barsCache = new Map<string, PriceBar[]>();

  for (const row of rows) {
    const watchlistTickers = (row.algorithm_watchlist ?? []).map((w) => w.ticker);
    const algoLite = {
      id: row.id,
      name: row.name,
      user_id: row.user_id,
      capital: Number(row.capital),
      rules: row.rules,
      watchlist_tickers: watchlistTickers,
    };
    // Layer-B extraction check BEFORE bar-loading — saves a DB hit when
    // the algo can't be WFO'd at all (vol_target sizing, non-Layer-B
    // geometry, etc.). Also ensures the skip-reason in the report
    // reflects the FIRST blocker, not whichever check happens to fire
    // first in the pipeline.
    const currentGeo = extractCurrentGeometry(row.rules);
    if (!currentGeo) {
      skipped.push({
        algorithm_id: row.id,
        algorithm_name: row.name,
        reason: "no_layer_b_geometry",
        detail: "Algo rules don't fit Layer B template (swing_anchor SL + rr_multiple TP + risk_per_trade sizing + grid-valued geometry)",
      });
      continue;
    }
    const ticker = watchlistTickers[0];
    if (!ticker) {
      skipped.push({
        algorithm_id: row.id,
        algorithm_name: row.name,
        reason: "no_bars_cached",
        detail: "Algo has no watchlist ticker",
      });
      continue;
    }
    const interval = row.rules.timeframe;
    const cacheKey = `${ticker}|${interval}`;
    let bars = barsCache.get(cacheKey);
    if (!bars) {
      const loaded = await loadCachedBars(supabase, ticker, interval);
      if (!loaded) {
        skipped.push({
          algorithm_id: row.id,
          algorithm_name: row.name,
          reason: "no_bars_cached",
          detail: `No cached bars for ${ticker} ${interval}`,
        });
        continue;
      }
      bars = loaded;
      barsCache.set(cacheKey, bars);
    }
    const ctxBars = new Map<string, PriceBar[]>([[ticker, bars]]);
    const result = computeWfoProposal(algoLite, { barsByTicker: ctxBars, config, now });

    if ("reason" in result) {
      skipped.push(result);
      continue;
    }
    proposals.push(result);

    if (!opts.dry_run && result.passes_buffer && result.rules_changed) {
      const { error: updErr } = await supabase
        .from("algorithms")
        .update({ rules: result.proposed_rules })
        .eq("id", row.id);
      if (updErr) throw new Error(`wfo UPDATE failed for ${row.id}: ${updErr.message}`);
      const { error: logErr } = await supabase.from("activity_log").insert({
        user_id: row.user_id,
        algorithm_id: row.id,
        event_type: "wfo_rules_updated",
        details: {
          before_geometry: result.current_geometry,
          after_geometry: result.best_geometry,
          before_dsr: result.current_dsr,
          after_dsr: result.best_dsr,
          dsr_improvement: result.dsr_improvement,
          window_start: result.window_start,
          window_end: result.window_end,
          trades_in_window: result.trades_in_window,
          config,
        },
      });
      if (logErr) {
        console.error(`[wfo] activity_log insert failed for ${row.id}:`, logErr.message);
      }
      applied.push({
        algorithm_id: row.id,
        algorithm_name: row.name,
        before_geometry: result.current_geometry as LayerBGeometry,
        after_geometry: result.best_geometry,
        before_dsr: result.current_dsr,
        after_dsr: result.best_dsr,
        dsr_improvement: result.dsr_improvement,
      });
    }
  }

  return {
    generated_at: now.toISOString(),
    dry_run: opts.dry_run,
    evaluated: rows.length,
    proposals,
    skipped,
    applied,
  };
}
