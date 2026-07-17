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
  /** Per-trade R-multiples for correlation (Pearson on monthly aggregates). */
  per_trade_r: readonly number[];
  /** ISO exit-date strings parallel to per_trade_r (for monthly aggregation + combined-DD). */
  exit_dates: readonly string[];
  /** Per-trade DOLLAR pnl for realistic combined-DD dollar-pool simulation
   *  (E2.11 fix 2026-06-29 EVE LATE). Length must equal per_trade_r.length.
   *  Required for any portfolio risk gate that maps to FTMO/operator dollar limits. */
  per_trade_pnl_dollars: readonly number[];
  /** Static DD from per-candidate backtest (used as a tiebreak + sanity log). */
  max_drawdown_pct: number;
}

export interface PortfolioComposerConfig {
  pairwise_correlation_ceiling: number; // default 0.40
  combined_portfolio_dd_ceiling: number; // default 5.0 (operator DD-gate; was 10.0 — corrected E2.11)
  combined_portfolio_daily_dd_ceiling: number; // default 5.0 (FTMO daily DD)
  max_portfolio_size: number; // default 5
  min_portfolio_size: number; // default 1 (fallback)
  pool_capital: number; // default 10000 — shared capital pool for dollar-pool DD sim
}

export const DEFAULT_PORTFOLIO_COMPOSER_CONFIG: PortfolioComposerConfig = {
  pairwise_correlation_ceiling: 0.4,
  // E2.11 fix: default lowered 10.0 → 5.0 to match [[feedback_dd_validation_gate]]
  // operator-locked rule. Was 10.0 (FTMO-only); operator's tighter rule is 5%.
  combined_portfolio_dd_ceiling: 5.0,
  combined_portfolio_daily_dd_ceiling: 5.0,
  max_portfolio_size: 5,
  min_portfolio_size: 1,
  pool_capital: 10000,
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

/** Combined-DD (REALISTIC dollar-pool sim — E2.11 fix 2026-06-29 EVE LATE).
 *
 *  Walks a SINGLE equity curve at DOLLAR precision with each algo
 *  contributing its actual per-trade pnl to a SHARED capital pool.
 *  Returns peak-to-trough as percentage of pool_capital.
 *
 *  Replaces prior 1/N R-scaling proxy that underestimated true DD by ~3x
 *  (empirically verified 2026-06-29 EVE LATE on E2.10 portfolio: proxy
 *  said 9.66%, dollar-pool sim said 28.98%). The proxy assumed equal-
 *  weight risk allocation (each algo at 1/N risk) which is operationally
 *  wrong — in deployment each algo runs at its OWN backtested risk and
 *  the pool absorbs all losses.
 *
 *  Mirrors `scripts/canonical/portfolio-realistic-sim.ts` logic.
 *
 *  See `[[feedback_combined_dd_proxy_misleading]]` memory. */
export function combinedDrawdownPct(
  candidates: ReadonlyArray<{
    per_trade_pnl_dollars: readonly number[];
    exit_dates: readonly string[];
  }>,
  poolCapital: number,
): number {
  if (candidates.length === 0 || poolCapital <= 0) return 0;
  const events: Array<{ date: string; pnl: number }> = [];
  for (const c of candidates) {
    for (let i = 0; i < c.per_trade_pnl_dollars.length; i++) {
      events.push({ date: c.exit_dates[i], pnl: c.per_trade_pnl_dollars[i] });
    }
  }
  events.sort((x, y) => x.date.localeCompare(y.date));
  let equity = poolCapital, peak = poolCapital, maxDdDollars = 0;
  for (const e of events) {
    equity += e.pnl;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDdDollars) maxDdDollars = dd;
  }
  return (maxDdDollars / poolCapital) * 100;
}

/** Combined DAILY DD (worst single-day net PnL as % of pool capital).
 *  Companion to combinedDrawdownPct for FTMO daily-DD gate (≤5%). */
export function combinedDailyDrawdownPct(
  candidates: ReadonlyArray<{
    per_trade_pnl_dollars: readonly number[];
    exit_dates: readonly string[];
  }>,
  poolCapital: number,
): number {
  if (candidates.length === 0 || poolCapital <= 0) return 0;
  const dailyPnl = new Map<string, number>();
  for (const c of candidates) {
    for (let i = 0; i < c.per_trade_pnl_dollars.length; i++) {
      const day = c.exit_dates[i].slice(0, 10);
      dailyPnl.set(day, (dailyPnl.get(day) ?? 0) + c.per_trade_pnl_dollars[i]);
    }
  }
  let worst = 0;
  for (const pnl of dailyPnl.values()) {
    if (pnl < worst) worst = pnl;
  }
  return (Math.abs(worst) / poolCapital) * 100;
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

    // First candidate: must individually pass DD ceiling (no longer
    // unconditional accept — the prior version's "accept first regardless"
    // was a holdover from the buggy proxy; with realistic dollar-pool DD,
    // a first candidate whose own DD exceeds the ceiling shouldn't be the
    // foundation for a portfolio. Spec line 232 fallback (size-1) handled
    // post-loop via fallback_applied.)
    if (selected.length === 0) {
      const dd = combinedDrawdownPct([c], config.pool_capital);
      if (dd > config.combined_portfolio_dd_ceiling) {
        log.push({
          candidate_id: c.id,
          action: "skipped_combined_dd",
          max_corr_with_selected: null,
          combined_dd_with_selected_pct: dd,
          selected_size_after: 0,
        });
        continue;
      }
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
    // Written but never read — kept for debugger visibility of which pair
    // tripped the ceiling. Underscore satisfies no-unused-vars (2026-07-09).
    let _maxCorrPair: { a: string; b: string; corr: number } | null = null;
    for (const s of selected) {
      const sMonthly = monthly.get(s.id) ?? [];
      const { a_aligned, b_aligned } = alignMonthlySeries(cMonthly, sMonthly);
      const corr = pearsonCorrelation(a_aligned, b_aligned);
      allCorrelations.push({ a: c.id, b: s.id, corr });
      if (Math.abs(corr) > Math.abs(maxCorr)) {
        maxCorr = corr;
        _maxCorrPair = { a: c.id, b: s.id, corr };
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

    // Check combined-DD with proposed addition (dollar-pool sim)
    const combinedDd = combinedDrawdownPct([...selected, c], config.pool_capital);
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

  // Fallback per spec line 232: if greedy produced 0, force top-1 candidate
  // that individually passes the DD ceiling (E2.11 fix: prior version forced
  // top-1 even if it breached DD — that's dishonest). If NO candidate
  // passes DD individually, fallback to empty portfolio + flag for operator.
  let fallback = false;
  if (selected.length < config.min_portfolio_size && rankedCandidates.length > 0) {
    for (const c of rankedCandidates) {
      const dd = combinedDrawdownPct([c], config.pool_capital);
      if (dd <= config.combined_portfolio_dd_ceiling) {
        selected.length = 0;
        selected.push(c);
        fallback = true;
        break;
      }
    }
  }

  const finalDd = combinedDrawdownPct(selected, config.pool_capital);

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

/** Compute per-trade dollar pnl from BacktestTrade[] (already in dollars).
 *  Companion to perTradeRFromTrades for the realistic combined-DD pool sim. */
export function perTradePnlDollarsFromTrades(
  trades: readonly BacktestTrade[],
): { pnl: number[]; exit_dates: string[] } {
  return {
    pnl: trades.map((t) => t.pnl),
    exit_dates: trades.map((t) => t.exit_date),
  };
}
