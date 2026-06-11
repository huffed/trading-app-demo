"use server";

import { getCachedPrices, savePricesToCache } from "@/lib/market-data/price-cache";
import { fetchDailyPrices } from "@/lib/market-data/prices";
import type { BacktestMetrics, PriceBar } from "@/lib/market-data/types";
import { getAuthedUser } from "@/lib/supabase/get-authed-user";
import { rulesFromRow } from "@/lib/supabase/row-mappers";
import { type ActionResult } from "@/lib/types/action-result";
import type { AlgorithmRules } from "@/types/algorithm";
import { discoverTickers } from "./discovery-actions";
import { bulkAddWatchlistItems } from "./watchlist-actions";

/**
 * Tolerance for accepting a candidate that adds drawdown. The argument
 * for ANY tolerance: a ticker that adds 0.5pp DD but +5% return is a net
 * win. The argument against generosity: drawdown is what blows up the
 * account in a real challenge window. 1pp is conservative — anything
 * above means measurably riskier.
 */
const MAX_DD_INCREASE_PCT = 1;

export interface ScreenedTicker {
  ticker: string;
  name: string;
  sector: string;
  /** Portfolio metrics WITH this candidate added on top of the existing
   *  baseline watchlist. null if the backtest couldn't run (no prices). */
  metrics: BacktestMetrics | null;
  /** Total return as a percent of starting capital (signed) — portfolio
   *  level, not the candidate alone. */
  return_pct: number;
  analysis: string;
  /** Δ baseline-with-candidate vs baseline-without. */
  delta_return_pct: number;
  delta_max_dd_pct: number;
  delta_win_rate_pct: number;
  /** True iff the candidate improves portfolio return without worsening
   *  drawdown beyond the tolerance. */
  improves_portfolio: boolean;
  /** Set when improves_portfolio is false — explains the rejection. */
  rejection_reason?: string;
}

export interface ScreenResult {
  tickers: ScreenedTicker[];
  added: number;
  baseline_metrics: {
    return_pct: number;
    max_dd_pct: number;
    win_rate_pct: number;
    trades: number;
  } | null;
}

async function fetchPricesForPortfolio(
  tickers: string[],
  rules: AlgorithmRules
): Promise<Map<string, PriceBar[]>> {
  const { timeframeToInterval, recommendedOutputSize, minBarsFor } = await import(
    "@/lib/market-data/interval"
  );
  const interval = timeframeToInterval(rules.timeframe);
  const outputSize = recommendedOutputSize(interval);
  const minBars = minBarsFor(interval);
  const out = new Map<string, PriceBar[]>();
  for (const ticker of tickers) {
    let prices = await getCachedPrices(ticker, outputSize, interval);
    if (!prices) {
      try {
        prices = await fetchDailyPrices(ticker, outputSize, interval);
        savePricesToCache(ticker, outputSize, prices, interval).catch(() => {});
      } catch (e) {
        console.warn(
          `[seed-watchlist] price fetch failed for ${ticker}:`,
          e instanceof Error ? e.message : e
        );
        continue;
      }
    }
    if (prices && prices.length >= minBars) out.set(ticker, prices);
  }
  return out;
}

async function fetchPortfolioEvents(
  rules: AlgorithmRules,
  pricesByTicker: Map<string, PriceBar[]>
) {
  const { fetchEconomicCalendar } = await import("@/lib/market-data/economic-calendar");
  if (!rules.news_veto?.enabled) return [];
  let earliest = new Date();
  let latest = new Date(0);
  for (const prices of pricesByTicker.values()) {
    if (prices.length === 0) continue;
    const a = new Date(prices[0].date);
    const b = new Date(prices[prices.length - 1].date);
    if (a < earliest) earliest = a;
    if (b > latest) latest = b;
  }
  if (latest <= earliest) return [];
  return fetchEconomicCalendar(earliest, latest);
}

interface PortfolioStats {
  return_pct: number;
  max_dd_pct: number;
  win_rate_pct: number;
  trades: number;
  metrics: BacktestMetrics;
}

async function evaluatePortfolio(
  rules: AlgorithmRules,
  capital: number,
  pricesByTicker: Map<string, PriceBar[]>,
  events: Awaited<ReturnType<typeof fetchPortfolioEvents>>
): Promise<PortfolioStats | null> {
  if (pricesByTicker.size === 0) return null;
  const { runPortfolioBacktest } = await import("@/lib/market-data/portfolio-backtest");
  const metrics = runPortfolioBacktest(rules, pricesByTicker, capital, events);
  return {
    return_pct: capital > 0 ? (metrics.total_return / capital) * 100 : 0,
    max_dd_pct: metrics.max_drawdown ?? 0,
    win_rate_pct: metrics.win_rate ?? 0,
    trades: metrics.total_trades ?? 0,
    metrics,
  };
}

function buildCandidateRow(
  s: { ticker: string; name: string; sector: string; reasoning: string },
  baseline: PortfolioStats | null,
  candidate: PortfolioStats | null
): ScreenedTicker {
  if (!candidate) {
    return {
      ticker: s.ticker,
      name: s.name,
      sector: s.sector,
      metrics: null,
      return_pct: 0,
      analysis: s.reasoning,
      delta_return_pct: 0,
      delta_max_dd_pct: 0,
      delta_win_rate_pct: 0,
      improves_portfolio: false,
      rejection_reason: "Backtest failed (no price data or insufficient bars)",
    };
  }
  const decision = decideAcceptance(baseline, candidate);
  return {
    ticker: s.ticker,
    name: s.name,
    sector: s.sector,
    metrics: candidate.metrics,
    return_pct: Number(candidate.return_pct.toFixed(2)),
    analysis: s.reasoning,
    delta_return_pct: Number((candidate.return_pct - (baseline?.return_pct ?? 0)).toFixed(2)),
    delta_max_dd_pct: Number((candidate.max_dd_pct - (baseline?.max_dd_pct ?? 0)).toFixed(2)),
    delta_win_rate_pct: Number(
      (candidate.win_rate_pct - (baseline?.win_rate_pct ?? 0)).toFixed(2)
    ),
    improves_portfolio: decision.improves,
    rejection_reason: decision.reason,
  };
}

interface ScreenContext {
  rules: AlgorithmRules;
  capital: number;
  baselinePricesMap: Map<string, PriceBar[]>;
  pricesByTicker: Map<string, PriceBar[]>;
  events: Awaited<ReturnType<typeof fetchPortfolioEvents>>;
  baseline: PortfolioStats | null;
}

async function screenCandidates(
  ctx: ScreenContext,
  suggestions: { ticker: string; name: string; sector: string; reasoning: string }[]
): Promise<ScreenedTicker[]> {
  const screened: ScreenedTicker[] = [];
  for (const s of suggestions) {
    const candidatePrices = ctx.pricesByTicker.get(s.ticker);
    if (!candidatePrices) {
      screened.push(buildCandidateRow(s, ctx.baseline, null));
      continue;
    }
    const combined = new Map(ctx.baselinePricesMap);
    combined.set(s.ticker, candidatePrices);
    const candidate = await evaluatePortfolio(ctx.rules, ctx.capital, combined, ctx.events);
    screened.push(buildCandidateRow(s, ctx.baseline, candidate));
  }
  return screened;
}

function decideAcceptance(
  baseline: PortfolioStats | null,
  candidate: PortfolioStats
): { improves: boolean; reason?: string } {
  // No baseline (empty watchlist): single-ticker case — accept if profitable.
  if (!baseline) {
    if (candidate.return_pct > 0) return { improves: true };
    return {
      improves: false,
      reason: `Standalone return ${candidate.return_pct.toFixed(2)}% — not profitable on its own`,
    };
  }
  const deltaReturn = candidate.return_pct - baseline.return_pct;
  const deltaMaxDd = candidate.max_dd_pct - baseline.max_dd_pct;
  if (deltaReturn <= 0) {
    return {
      improves: false,
      reason: `Adds no return: portfolio Δ ${deltaReturn >= 0 ? "+" : ""}${deltaReturn.toFixed(2)}%`,
    };
  }
  if (deltaMaxDd > MAX_DD_INCREASE_PCT) {
    return {
      improves: false,
      reason: `Worsens max DD by ${deltaMaxDd.toFixed(2)}pp (cap +${MAX_DD_INCREASE_PCT}pp)`,
    };
  }
  return { improves: true };
}

export async function seedWatchlist(algorithmId: string): Promise<ActionResult<ScreenResult>> {
  const { supabase, user } = await getAuthedUser();

  const { data: algo, error: algoErr } = await supabase
    .from("algorithms")
    .select("*")
    .eq("id", algorithmId)
    .eq("user_id", user.id)
    .single();
  if (algoErr || !algo) return { success: false, error: "Algorithm not found" };

  // Baseline = currently active watchlist (skip auto-paused, those wouldn't
  // trade live so they shouldn't anchor the comparison either).
  const { data: existingWatchlist } = await supabase
    .from("algorithm_watchlist")
    .select("ticker, auto_paused")
    .eq("algorithm_id", algorithmId);
  const baselineTickers = ((existingWatchlist ?? []) as { ticker: string; auto_paused: boolean }[])
    .filter((w) => !w.auto_paused)
    .map((w) => w.ticker.toUpperCase());

  const discoveryResult = await discoverTickers(algorithmId);
  if (!discoveryResult.success) return { success: false, error: discoveryResult.error };
  const suggestions = discoveryResult.data;
  if (suggestions.length === 0) {
    return { success: true, data: { tickers: [], added: 0, baseline_metrics: null } };
  }

  const rules = rulesFromRow(algo.rules);
  const capital = algo.capital;

  // Fetch prices once for the union of (baseline ∪ candidates). Cache
  // hits make this cheap on repeat clicks.
  const allTickers = Array.from(new Set([...baselineTickers, ...suggestions.map((s) => s.ticker)]));
  const pricesByTicker = await fetchPricesForPortfolio(allTickers, rules);

  // Calendar covers the full price range — same events for every backtest.
  const events = await fetchPortfolioEvents(rules, pricesByTicker);

  // Baseline portfolio (without any candidates).
  const baselinePricesMap = new Map<string, PriceBar[]>();
  for (const t of baselineTickers) {
    const p = pricesByTicker.get(t);
    if (p) baselinePricesMap.set(t, p);
  }
  const baseline = await evaluatePortfolio(rules, capital, baselinePricesMap, events);

  const screened = await screenCandidates(
    { rules, capital, baselinePricesMap, pricesByTicker, events, baseline },
    suggestions
  );

  // Sort: improvers first (highest return delta), then rejected.
  screened.sort((a, b) => {
    if (a.improves_portfolio !== b.improves_portfolio) return a.improves_portfolio ? -1 : 1;
    return b.delta_return_pct - a.delta_return_pct;
  });

  const accepted = screened.filter((t) => t.improves_portfolio);
  if (accepted.length > 0) {
    await bulkAddWatchlistItems(
      algorithmId,
      accepted.map((t) => ({ symbol: t.ticker, name: t.name })),
      "ai"
    );
  }

  return {
    success: true,
    data: {
      tickers: screened,
      added: accepted.length,
      baseline_metrics: baseline
        ? {
            return_pct: Number(baseline.return_pct.toFixed(2)),
            max_dd_pct: Number(baseline.max_dd_pct.toFixed(2)),
            win_rate_pct: Number(baseline.win_rate_pct.toFixed(2)),
            trades: baseline.trades,
          }
        : null,
    },
  };
}
