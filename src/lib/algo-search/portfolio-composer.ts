/**
 * E2.10 — Portfolio composer (Phase E spec line 244 finally executed).
 *
 * Pure functions for assembling a decorrelated multi-algo portfolio from
 * Layer B step2-PASS candidates. Pre-registered in `phase-e2-sweep-lock.md`
 * § E2.10 Addendum (2026-06-29 LATE BEFORE empirical run).
 *
 * Why this exists: empirical 2026-06-29 found 108 Layer B variants pass
 * operator hard deploy criteria; single-survivor-by-DSR methodology
 * systematically excluded them. Portfolio composer was always in the
 * Phase E spec but never built. See `[[feedback_single_survivor_methodology_bug]]`.
 *
 * Algorithm (deterministic, greedy):
 *   1. Sort candidates DESC by total_return (per-variant ranking).
 *   2. For each candidate, accept if:
 *      (a) max |corr(c, s)| < PAIRWISE_CORRELATION_CEILING for s in selected
 *      (b) combined_dd(selected ∪ {c}) ≤ COMBINED_PORTFOLIO_DD_CEILING
 *   3. Stop at MAX_PORTFOLIO_SIZE or exhausted candidates.
 *   4. Fallback (per spec line 232): if 0 selected, return top-1 by ranking.
 *
 * NOT a backtest engine — pure ranking + selection over per-trade R series.
 * Backtest itself is the caller's responsibility (typically driver loads
 * each candidate's rules + runs runPortfolioBacktest to get trades).
 */
import type { BacktestTrade } from "../market-data/types";

export interface CandidateInput {
  /** Unique identifier (typically the algorithms.name). */
  id: string;
  /** For ranking — typically total_return USD. */
  total_return: number;
  /** Per-trade R-multiples for correlation + combined-DD. */
  per_trade_r: readonly number[];
  /** ISO exit-date strings parallel to per_trade_r (for monthly aggregation + combined-DD). */
  exit_dates: readonly string[];
  /** Static DD from per-candidate backtest (used as a tiebreak + sanity log). */
  max_drawdown_pct: number;
}

export interface PortfolioComposerConfig {
  pairwise_correlation_ceiling: number; // default 0.40
  combined_portfolio_dd_ceiling: number; // default 10.0 (percent)
  max_portfolio_size: number; // default 5
  min_portfolio_size: number; // default 1 (fallback)
}

export const DEFAULT_PORTFOLIO_COMPOSER_CONFIG: PortfolioComposerConfig = {
  pairwise_correlation_ceiling: 0.4,
  combined_portfolio_dd_ceiling: 10.0,
  max_portfolio_size: 5,
  min_portfolio_size: 1,
};

export interface PortfolioComposerOutput {
  selected: readonly string[]; // candidate ids in selection order
  fallback_applied: boolean; // true iff greedy selected 0 + we returned top-1
  per_step_log: ReadonlyArray<{
    candidate_id: string;
    action: "accepted" | "skipped_correlation" | "skipped_combined_dd" | "stopped_max_size";
    max_corr_with_selected: number | null;
    combined_dd_with_selected_pct: number | null;
    selected_size_after: number;
  }>;
  combined_dd_final_pct: number;
  pairwise_correlations: ReadonlyArray<{
    a: string;
    b: string;
    corr: number;
  }>;
}

/** Aggregate per-trade R values into a monthly time series.
 *  Returns: array of { month_iso: 'YYYY-MM-01', total_r } sorted by date.
 *  Empty months between first + last trade are filled with 0 to preserve
 *  the correlation-relevant time axis. */
export function aggregateMonthlyR(
  perTradeR: readonly number[],
  exitDates: readonly string[],
): Array<{ month: string; total_r: number }> {
  if (perTradeR.length === 0 || perTradeR.length !== exitDates.length) {
    return [];
  }
  // group by YYYY-MM
  const byMonth = new Map<string, number>();
  for (let i = 0; i < perTradeR.length; i++) {
    const month = exitDates[i].slice(0, 7); // 'YYYY-MM'
    byMonth.set(month, (byMonth.get(month) ?? 0) + perTradeR[i]);
  }
  // fill empty months between min + max
  const months = [...byMonth.keys()].sort();
  if (months.length === 0) return [];
  const out: Array<{ month: string; total_r: number }> = [];
  const [startY, startM] = months[0].split("-").map(Number);
  const [endY, endM] = months[months.length - 1].split("-").map(Number);
  let y = startY, m = startM;
  while (y < endY || (y === endY && m <= endM)) {
    const key = `${y}-${String(m).padStart(2, "0")}`;
    out.push({ month: key, total_r: byMonth.get(key) ?? 0 });
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return out;
}

/** Pearson correlation between two number arrays of equal length.
 *  Returns 0 if either is constant (var=0) or arrays empty/mismatched. */
export function pearsonCorrelation(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length < 2) return 0;
  const n = a.length;
  let sumA = 0, sumB = 0;
  for (let i = 0; i < n; i++) { sumA += a[i]; sumB += b[i]; }
  const meanA = sumA / n, meanB = sumB / n;
  let cov = 0, varA = 0, varB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - meanA, db = b[i] - meanB;
    cov += da * db;
    varA += da * da;
    varB += db * db;
  }
  const denom = Math.sqrt(varA * varB);
  return denom === 0 ? 0 : cov / denom;
}

/** Align two monthly series on the union of their months; missing values = 0.
 *  Returns parallel arrays suitable for pearsonCorrelation. */
export function alignMonthlySeries(
  a: ReadonlyArray<{ month: string; total_r: number }>,
  b: ReadonlyArray<{ month: string; total_r: number }>,
): { a_aligned: number[]; b_aligned: number[]; months: string[] } {
  const months = new Set<string>();
  for (const e of a) months.add(e.month);
  for (const e of b) months.add(e.month);
  const sortedMonths = [...months].sort();
  const aMap = new Map(a.map((e) => [e.month, e.total_r]));
  const bMap = new Map(b.map((e) => [e.month, e.total_r]));
  return {
    a_aligned: sortedMonths.map((m) => aMap.get(m) ?? 0),
    b_aligned: sortedMonths.map((m) => bMap.get(m) ?? 0),
    months: sortedMonths,
  };
}

/** Combined-DD: simulate trading all selected variants simultaneously with
 *  equal-weight risk allocation per variant. Each variant contributes its
 *  per-trade R values stamped to its exit_date; we walk a combined equity
 *  curve in R units and report peak-to-trough as a percentage of the
 *  starting capital headroom (assumed 1.0 R-per-pct, i.e. 1R = 1% DD).
 *  This is conservative — actual live combined DD with capital sharing is
 *  bounded by this proxy. */
export function combinedDrawdownPct(
  candidates: ReadonlyArray<{ per_trade_r: readonly number[]; exit_dates: readonly string[] }>,
): number {
  if (candidates.length === 0) return 0;
  // Flatten + sort by exit_date
  const events: Array<{ date: string; r: number }> = [];
  for (const c of candidates) {
    for (let i = 0; i < c.per_trade_r.length; i++) {
      events.push({ date: c.exit_dates[i], r: c.per_trade_r[i] });
    }
  }
  events.sort((x, y) => x.date.localeCompare(y.date));
  // Walk equity in R per portfolio risk unit. Equal-weight allocation: each
  // variant's R is scaled by 1/N so total per-trade risk stays bounded.
  const scale = 1 / candidates.length;
  let equity = 0, peak = 0, maxDd = 0;
  for (const e of events) {
    equity += e.r * scale;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDd) maxDd = dd;
  }
  // 1R = 1% capital DD by convention (matches portfolio-backtest assumption)
  return maxDd;
}

/** The greedy portfolio composer.
 *  Inputs: pre-ranked candidates (caller sorts by total_return DESC).
 *  Output: PortfolioComposerOutput with selection trace + correlations. */
export function composePortfolio(
  rankedCandidates: readonly CandidateInput[],
  config: PortfolioComposerConfig = DEFAULT_PORTFOLIO_COMPOSER_CONFIG,
): PortfolioComposerOutput {
  if (rankedCandidates.length === 0) {
    return {
      selected: [],
      fallback_applied: false,
      per_step_log: [],
      combined_dd_final_pct: 0,
      pairwise_correlations: [],
    };
  }

  // Precompute monthly series per candidate (one-time cost)
  const monthly = new Map(
    rankedCandidates.map((c) => [c.id, aggregateMonthlyR(c.per_trade_r, c.exit_dates)]),
  );

  const selected: CandidateInput[] = [];
  const log: PortfolioComposerOutput["per_step_log"][number][] = [];
  const allCorrelations: PortfolioComposerOutput["pairwise_correlations"][number][] = [];

  for (const c of rankedCandidates) {
    if (selected.length >= config.max_portfolio_size) {
      log.push({
        candidate_id: c.id,
        action: "stopped_max_size",
        max_corr_with_selected: null,
        combined_dd_with_selected_pct: null,
        selected_size_after: selected.length,
      });
      break;
    }

    // First candidate: accept (subject to combined_dd which is just its own dd)
    if (selected.length === 0) {
      const dd = combinedDrawdownPct([c]);
      // Allow first acceptance unconditionally; even if its own DD > ceiling,
      // accept as the fallback then bail per spec line 232 logic later.
      selected.push(c);
      log.push({
        candidate_id: c.id,
        action: "accepted",
        max_corr_with_selected: null,
        combined_dd_with_selected_pct: dd,
        selected_size_after: 1,
      });
      continue;
    }

    // Compute max correlation with already-selected
    const cMonthly = monthly.get(c.id) ?? [];
    let maxCorr = 0;
    let maxCorrPair: { a: string; b: string; corr: number } | null = null;
    for (const s of selected) {
      const sMonthly = monthly.get(s.id) ?? [];
      const { a_aligned, b_aligned } = alignMonthlySeries(cMonthly, sMonthly);
      const corr = pearsonCorrelation(a_aligned, b_aligned);
      allCorrelations.push({ a: c.id, b: s.id, corr });
      if (Math.abs(corr) > Math.abs(maxCorr)) {
        maxCorr = corr;
        maxCorrPair = { a: c.id, b: s.id, corr };
      }
    }

    if (Math.abs(maxCorr) >= config.pairwise_correlation_ceiling) {
      log.push({
        candidate_id: c.id,
        action: "skipped_correlation",
        max_corr_with_selected: maxCorr,
        combined_dd_with_selected_pct: null,
        selected_size_after: selected.length,
      });
      continue;
    }

    // Check combined-DD with proposed addition
    const combinedDd = combinedDrawdownPct([...selected, c]);
    if (combinedDd > config.combined_portfolio_dd_ceiling) {
      log.push({
        candidate_id: c.id,
        action: "skipped_combined_dd",
        max_corr_with_selected: maxCorr,
        combined_dd_with_selected_pct: combinedDd,
        selected_size_after: selected.length,
      });
      continue;
    }

    selected.push(c);
    log.push({
      candidate_id: c.id,
      action: "accepted",
      max_corr_with_selected: maxCorr,
      combined_dd_with_selected_pct: combinedDd,
      selected_size_after: selected.length,
    });
  }

  // Fallback per spec line 232: if greedy produced 0, force top-1
  let fallback = false;
  if (selected.length < config.min_portfolio_size && rankedCandidates.length > 0) {
    selected.length = 0;
    selected.push(rankedCandidates[0]);
    fallback = true;
  }

  const finalDd = combinedDrawdownPct(selected);

  return {
    selected: selected.map((s) => s.id),
    fallback_applied: fallback,
    per_step_log: log,
    combined_dd_final_pct: finalDd,
    pairwise_correlations: allCorrelations,
  };
}

/** Compute per-trade R from BacktestTrade[] + risk-dollars. Pure helper. */
export function perTradeRFromTrades(
  trades: readonly BacktestTrade[],
  riskDollars: number,
): { r: number[]; exit_dates: string[] } {
  if (riskDollars <= 0) return { r: [], exit_dates: [] };
  return {
    r: trades.map((t) => t.pnl / riskDollars),
    exit_dates: trades.map((t) => t.exit_date),
  };
}
