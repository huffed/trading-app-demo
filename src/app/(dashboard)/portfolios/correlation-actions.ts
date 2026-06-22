"use server";

import { getAuthedUser } from "@/lib/supabase/get-authed-user";
import { type ActionResult } from "@/types/action-result";

const DEFAULT_LOOKBACK_DAYS = 90;
const MIN_PAIRED_DAYS = 10;
const HIGH_CORRELATION_THRESHOLD = 0.7;

interface ClosedRow {
  algorithm_id: string;
  closed_at: string | null;
  realized_pnl: number | null;
}

interface AlgoSummary {
  id: string;
  name: string;
}

export interface CorrelationCell {
  algorithm_a: string;
  algorithm_b: string;
  /** -1..1, or null when fewer than MIN_PAIRED_DAYS overlapping days. */
  correlation: number | null;
  /** Count of UTC days both algos had a closed trade. */
  paired_days: number;
}

export interface PortfolioCorrelationResult {
  algorithms: AlgoSummary[];
  cells: CorrelationCell[];
  high_correlation_pairs: CorrelationCell[];
  lookback_days: number;
}

/** UTC-midnight day key for grouping pnl. */
function dayKey(iso: string): string {
  return iso.slice(0, 10);
}

function pearsonCorrelation(xs: number[], ys: number[]): number | null {
  if (xs.length !== ys.length || xs.length < MIN_PAIRED_DAYS) return null;
  const n = xs.length;
  const meanX = xs.reduce((s, v) => s + v, 0) / n;
  const meanY = ys.reduce((s, v) => s + v, 0) / n;
  let cov = 0;
  let varX = 0;
  let varY = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;
    cov += dx * dy;
    varX += dx * dx;
    varY += dy * dy;
  }
  if (varX === 0 || varY === 0) return null;
  return cov / Math.sqrt(varX * varY);
}

function pairedSeries(
  a: Map<string, number>,
  b: Map<string, number>
): { xs: number[]; ys: number[] } {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [day, pnlA] of a) {
    const pnlB = b.get(day);
    if (pnlB !== undefined) {
      xs.push(pnlA);
      ys.push(pnlB);
    }
  }
  return { xs, ys };
}

/**
 * Pairwise correlation of every algorithm's daily P&L within a portfolio.
 * Source data is closed paper_positions over the last `lookback_days` —
 * real history beats synthetic-backtest correlation for the same reason
 * paper performance beats backtest expectations for live readiness.
 *
 * Returns one cell per unordered pair (algo_a < algo_b by id); the matrix
 * is symmetric. Cells with fewer than MIN_PAIRED_DAYS overlapping trading
 * days return null — early-stage portfolios don't have enough data to
 * report a meaningful correlation, and forcing a number would mislead.
 *
 * Wave 7 strategy search (auto-generated algorithms) will consult this to
 * avoid stacking correlated bets — three long-EUR/USD algos isn't
 * diversification, it's leverage.
 */
export async function getPortfolioCorrelation(
  portfolioId: string,
  lookbackDays: number = DEFAULT_LOOKBACK_DAYS
): Promise<ActionResult<PortfolioCorrelationResult>> {
  const { supabase, user } = await getAuthedUser();

  const { data: portfolio } = await supabase
    .from("portfolios")
    .select("id")
    .eq("id", portfolioId)
    .eq("user_id", user.id)
    .single();
  if (!portfolio) return { success: false, error: "Portfolio not found" };

  const { data: algos, error: algosErr } = await supabase
    .from("algorithms")
    .select("id, name")
    .eq("portfolio_id", portfolioId)
    .eq("user_id", user.id);
  if (algosErr) return { success: false, error: algosErr.message };
  const algoSummaries = (algos ?? []) as AlgoSummary[];
  if (algoSummaries.length < 2) {
    return {
      success: true,
      data: {
        algorithms: algoSummaries,
        cells: [],
        high_correlation_pairs: [],
        lookback_days: lookbackDays,
      },
    };
  }

  const since = new Date(Date.now() - lookbackDays * 86_400_000).toISOString();
  const { data: rows, error: rowsErr } = await supabase
    .from("paper_positions")
    .select("algorithm_id, closed_at, realized_pnl")
    .in(
      "algorithm_id",
      algoSummaries.map((a) => a.id)
    )
    .eq("status", "closed")
    .gte("closed_at", since);
  if (rowsErr) return { success: false, error: rowsErr.message };

  // Daily P&L vector per algorithm — keyed by UTC day, summed across the
  // multiple closes that can happen within a calendar day.
  const dailyByAlgo = new Map<string, Map<string, number>>();
  for (const r of (rows ?? []) as ClosedRow[]) {
    if (!r.closed_at) continue;
    const day = dayKey(r.closed_at);
    const algoMap = dailyByAlgo.get(r.algorithm_id) ?? new Map<string, number>();
    algoMap.set(day, (algoMap.get(day) ?? 0) + (r.realized_pnl ?? 0));
    dailyByAlgo.set(r.algorithm_id, algoMap);
  }

  const cells: CorrelationCell[] = [];
  for (let i = 0; i < algoSummaries.length; i++) {
    for (let j = i + 1; j < algoSummaries.length; j++) {
      const a = algoSummaries[i];
      const b = algoSummaries[j];
      const seriesA = dailyByAlgo.get(a.id) ?? new Map<string, number>();
      const seriesB = dailyByAlgo.get(b.id) ?? new Map<string, number>();
      const { xs, ys } = pairedSeries(seriesA, seriesB);
      cells.push({
        algorithm_a: a.id,
        algorithm_b: b.id,
        correlation: pearsonCorrelation(xs, ys),
        paired_days: xs.length,
      });
    }
  }

  const highCorrelationPairs = cells.filter(
    (c) => c.correlation !== null && Math.abs(c.correlation) >= HIGH_CORRELATION_THRESHOLD
  );

  return {
    success: true,
    data: {
      algorithms: algoSummaries,
      cells,
      high_correlation_pairs: highCorrelationPairs,
      lookback_days: lookbackDays,
    },
  };
}

export const CORRELATION_HIGH_THRESHOLD = HIGH_CORRELATION_THRESHOLD;
export const CORRELATION_MIN_PAIRED_DAYS = MIN_PAIRED_DAYS;
