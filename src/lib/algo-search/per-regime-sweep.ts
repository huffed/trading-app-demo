/**
 * H.6 — Per-regime sweep. Runs all 96 Layer B variants on the algo's
 * full bar history, partitions each variant's trades by entry-bar
 * regime, picks the per-regime best variant, and computes the
 * regime-routed combined Sharpe + DSR.
 *
 * Methodology — answers the question "if we'd switched geometry per
 * regime, what would our risk-adjusted return have been?":
 *
 *   1. Backtest all 96 variants once over full bars (same as G.5 WFO).
 *   2. Classify entry-bar regime for every trade across all variants.
 *   3. For each regime, find the variant with the best per-regime
 *      Sharpe (selected from the 96 candidates).
 *   4. Concatenate the regime-best variants' in-regime trades →
 *      a "regime-routed strategy" trade list.
 *   5. Compute Sharpe on the combined list. Compute DSR with
 *      nTrials = 96 × 3 (selection bias is per-regime over 96, three
 *      regimes are chosen independently) + trialSharpeStd taken across
 *      ALL per-regime (variant, regime) cells (288 cells).
 *   6. Compare to single-model baseline DSR (the algo's CURRENT
 *      geometry's full-bar DSR among the 96 variants).
 *
 * Gate (per ROADMAP H.6): combined DSR ≥ single-model DSR + 0.10.
 * Honest framing: for algos whose baseline DSR already saturates
 * near 1.0 (e.g. the v3 survivor at 0.983), the absolute +0.10 gate
 * is unreachable by construction (DSR ∈ [0, 1]). The DRIVER reports
 * the gate verdict literally per spec + the DELTA value so the
 * operator can read the result regardless.
 */
import { computeDeflatedSharpe } from "@/lib/stats/deflated-sharpe";
import type { PriceBar } from "@/lib/market-data/types";
import { runPortfolioBacktest } from "@/lib/market-data/portfolio-backtest";
import type { AlgorithmRules } from "@/types/algorithm";
import {
  enumerateLayerBVariants,
  layerBCardinality,
  type LayerBGeometry,
} from "./layer-b-enumerate";
import { classifyAllBars, REGIMES, type Regime } from "../algorithm/regime-classifier";

export interface PerRegimeStats {
  regime: Regime;
  n_trades: number;
  sharpe: number | null;
  /** Mean R-multiple across the in-regime trades. Null when n_trades < 1. */
  mean_r: number | null;
}

export interface PerRegimeVariantCell {
  variant_tag: string;
  geometry: LayerBGeometry;
  per_regime: Record<Regime, PerRegimeStats>;
  /** Full-bar Sharpe (all regimes pooled) — used to identify the
   *  "single-model" winner from the same 96-variant pool. */
  full_sharpe: number;
  /** Total trades across all regimes (sum of per-regime n_trades). */
  total_trades: number;
}

export interface RegimeRoutedResult {
  per_regime_best: Record<Regime, { variant_tag: string; geometry: LayerBGeometry; sharpe: number; n_trades: number }>;
  /** Sharpe of the concatenated regime-best trade list. */
  combined_sharpe: number;
  /** DSR with nTrials = 96 × 3 = 288 (selection over per-regime variant +
   *  three independent regime choices) + trialSharpeStd from all 288
   *  per-regime cells. */
  combined_dsr: number;
  /** Total combined trades. */
  total_trades: number;
}

export interface SingleModelResult {
  /** Index into `variants` of the single-model winner (best full-bar Sharpe). */
  variant_tag: string;
  geometry: LayerBGeometry;
  sharpe: number;
  /** DSR with nTrials = 96 (single-model selection over the standard
   *  Layer B pool) + trialSharpeStd over the 96 full-bar Sharpes. */
  dsr: number;
}

export interface PerRegimeSweepResult {
  ticker: string;
  timeframe: string;
  total_bars: number;
  classified_bars: number;
  total_variants: number;
  cells: PerRegimeVariantCell[];
  single_model: SingleModelResult;
  regime_routed: RegimeRoutedResult;
  dsr_delta: number; // regime_routed.combined_dsr - single_model.dsr
  /** Literal-spec gate: dsr_delta >= 0.10. Saturated-baseline cases
   *  may report `false` even when regime routing helps; the driver
   *  surfaces the raw delta. */
  passes_gate: boolean;
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

interface AlgoForSweep {
  name: string;
  capital: number;
  rules: AlgorithmRules;
  ticker: string;
  timeframe: string;
}

/** Map bar.date → bar index for O(1) lookups of "what regime was at
 *  the bar this trade entered on". Built once per sweep. */
function buildDateIndex(bars: PriceBar[]): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i < bars.length; i++) m.set(bars[i].date, i);
  return m;
}

/** Run all 96 Layer B variants once, build per-(variant, regime)
 *  cells. Pure (no DB/FS). Caller provides bars; module classifies. */
export function runPerRegimeSweep(
  algo: AlgoForSweep,
  bars: PriceBar[],
): PerRegimeSweepResult {
  const regimeByBarIdx = classifyAllBars(bars);
  const dateToBarIdx = buildDateIndex(bars);
  const classifiedBars = regimeByBarIdx.filter((r) => r !== null).length;

  // Enumerate the 96 variants from the algo's base shape
  const variants = enumerateLayerBVariants({
    name: `Search: ${algo.name.replace(/^LayerB:\s*/, "").split(" | ")[0]}`,
    ticker: algo.ticker,
    capital: algo.capital,
    rules: algo.rules,
  });

  const pricesByTicker = new Map<string, PriceBar[]>([[algo.ticker, bars]]);
  const cells: PerRegimeVariantCell[] = [];

  for (const v of variants) {
    const metrics = runPortfolioBacktest(v.rules, pricesByTicker, algo.capital);
    const trades = metrics.trades ?? [];
    const variantRiskPct = (v.rules.position_sizing as { value: number }).value;
    const riskDollars = algo.capital * (variantRiskPct / 100);
    if (riskDollars <= 0) continue;

    // Partition trades by entry-bar regime
    const perRegimeR: Record<Regime, number[]> = {
      low_vol: [], medium_vol: [], high_vol: [],
    };
    for (const t of trades) {
      const barIdx = dateToBarIdx.get(t.entry_date);
      if (barIdx == null) continue;
      const regime = regimeByBarIdx[barIdx];
      if (regime == null) continue;
      perRegimeR[regime].push(t.pnl / riskDollars);
    }

    const per_regime: Record<Regime, PerRegimeStats> = {
      low_vol: { regime: "low_vol", n_trades: 0, sharpe: null, mean_r: null },
      medium_vol: { regime: "medium_vol", n_trades: 0, sharpe: null, mean_r: null },
      high_vol: { regime: "high_vol", n_trades: 0, sharpe: null, mean_r: null },
    };
    for (const r of REGIMES) {
      const rs = perRegimeR[r];
      per_regime[r] = {
        regime: r,
        n_trades: rs.length,
        sharpe: rs.length >= 2 ? sharpeFromR(rs) : null,
        mean_r: rs.length >= 1 ? meanOf(rs) : null,
      };
    }

    const fullR: number[] = trades.map((t) => t.pnl / riskDollars);
    const full_sharpe = sharpeFromR(fullR);

    cells.push({
      variant_tag: v.variant_tag,
      geometry: v.geometry,
      per_regime,
      full_sharpe,
      total_trades: trades.length,
    });
  }

  // Single-model winner: best full-bar Sharpe across all 96 variants
  const sortedByFullSharpe = [...cells].sort((a, b) => b.full_sharpe - a.full_sharpe);
  const singleModelCell = sortedByFullSharpe[0];

  // Compute single-model DSR (nTrials = 96, trialSharpeStd over full Sharpes)
  const fullSharpes = cells.map((c) => c.full_sharpe);
  const fullTrialStd = stdOf(fullSharpes);
  // We need the per-trade R series for the single-model variant to feed
  // computeDeflatedSharpe (it computes skew + kurt over the returns).
  // Re-derive by running the variant once more — cheap.
  const smVariant = enumerateLayerBVariants({
    name: `Search: ${algo.name.replace(/^LayerB:\s*/, "").split(" | ")[0]}`,
    ticker: algo.ticker,
    capital: algo.capital,
    rules: algo.rules,
  }).find((v) => v.variant_tag === singleModelCell.variant_tag)!;
  const smMetrics = runPortfolioBacktest(smVariant.rules, pricesByTicker, algo.capital);
  const smRiskPct = (smVariant.rules.position_sizing as { value: number }).value;
  const smRiskDollars = algo.capital * (smRiskPct / 100);
  const smReturns = (smMetrics.trades ?? []).map((t) => t.pnl / smRiskDollars);
  const singleModelDsrResult = smReturns.length >= 2
    ? computeDeflatedSharpe({
      observedSharpe: singleModelCell.full_sharpe,
      returns: smReturns,
      nTrials: layerBCardinality(),
      trialSharpeStd: fullTrialStd,
    })
    : null;
  const singleModelDsr = singleModelDsrResult?.deflatedSharpe ?? 0;

  // Regime-routed: pick per-regime best variant by per-regime Sharpe
  const emptyBest = { variant_tag: "(none)", geometry: cells[0].geometry, sharpe: 0, n_trades: 0 };
  const perRegimeBest: Record<Regime, { variant_tag: string; geometry: LayerBGeometry; sharpe: number; n_trades: number }> = {
    low_vol: emptyBest, medium_vol: emptyBest, high_vol: emptyBest,
  };
  const combinedR: number[] = [];
  for (const regime of REGIMES) {
    // Filter to cells with ≥2 in-regime trades (Sharpe defined)
    const candidates = cells.filter((c) => c.per_regime[regime].sharpe != null);
    if (candidates.length === 0) {
      // Degenerate — no variant had ≥2 trades in this regime. Skip.
      perRegimeBest[regime] = {
        variant_tag: "(none)", geometry: cells[0].geometry, sharpe: 0, n_trades: 0,
      };
      continue;
    }
    const winner = candidates.sort((a, b) => (b.per_regime[regime].sharpe! - a.per_regime[regime].sharpe!))[0];
    perRegimeBest[regime] = {
      variant_tag: winner.variant_tag,
      geometry: winner.geometry,
      sharpe: winner.per_regime[regime].sharpe!,
      n_trades: winner.per_regime[regime].n_trades,
    };
    // Re-run the winner variant to get its per-trade R series for the
    // combined trade list. This is the LAST hot loop iteration; cheap.
    const wVariant = enumerateLayerBVariants({
      name: `Search: ${algo.name.replace(/^LayerB:\s*/, "").split(" | ")[0]}`,
      ticker: algo.ticker,
      capital: algo.capital,
      rules: algo.rules,
    }).find((v) => v.variant_tag === winner.variant_tag)!;
    const wMetrics = runPortfolioBacktest(wVariant.rules, pricesByTicker, algo.capital);
    const wRiskPct = (wVariant.rules.position_sizing as { value: number }).value;
    const wRiskDollars = algo.capital * (wRiskPct / 100);
    for (const t of wMetrics.trades ?? []) {
      const barIdx = dateToBarIdx.get(t.entry_date);
      if (barIdx == null) continue;
      if (regimeByBarIdx[barIdx] !== regime) continue;
      combinedR.push(t.pnl / wRiskDollars);
    }
  }

  const combinedSharpe = sharpeFromR(combinedR);
  // Per-regime trialSharpeStd: across all 288 (variant, regime) cells
  // where Sharpe is defined. This represents the full selection space.
  const allRegimeSharpes: number[] = [];
  for (const c of cells) {
    for (const r of REGIMES) {
      const s = c.per_regime[r].sharpe;
      if (s != null) allRegimeSharpes.push(s);
    }
  }
  const regimeTrialStd = stdOf(allRegimeSharpes);
  const combinedDsrResult = combinedR.length >= 2
    ? computeDeflatedSharpe({
      observedSharpe: combinedSharpe,
      returns: combinedR,
      nTrials: cells.length * REGIMES.length, // 96 × 3
      trialSharpeStd: regimeTrialStd,
    })
    : null;
  const combinedDsr = combinedDsrResult?.deflatedSharpe ?? 0;

  const dsrDelta = combinedDsr - singleModelDsr;

  return {
    ticker: algo.ticker,
    timeframe: algo.timeframe,
    total_bars: bars.length,
    classified_bars: classifiedBars,
    total_variants: cells.length,
    cells,
    single_model: {
      variant_tag: singleModelCell.variant_tag,
      geometry: singleModelCell.geometry,
      sharpe: singleModelCell.full_sharpe,
      dsr: singleModelDsr,
    },
    regime_routed: {
      per_regime_best: perRegimeBest,
      combined_sharpe: combinedSharpe,
      combined_dsr: combinedDsr,
      total_trades: combinedR.length,
    },
    dsr_delta: dsrDelta,
    passes_gate: dsrDelta >= 0.10,
  };
}
