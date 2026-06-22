/**
 * Aggregate readiness check for an algorithm — runs every quality
 * diagnostic we've built and returns a single verdict + itemised
 * PASS/CAUTION/FAIL list. The "should I put real money behind this?"
 * call, not buried under 4 separate endpoint calls.
 *
 * Checks:
 *  1. Walk-forward stability — at least N windows, ≥ X% green, mean
 *     return ≥ FTMO target × (window/180), worst-window DD ≤ Y%.
 *     For LLM-trader algos, the standard WF engine fires zero trades
 *     (entry_conditions are empty by design), so we read a cached WF
 *     result populated by the (currently archived) LLM-trader harness.
 *     The harness lives in `scripts/archive/2026-06-18/` and LLM-trader
 *     work is deferred to roadmap Stage 5.0 / Phase D.4 — see
 *     [[project_roadmap_2026_06]]. If LLM-trader is reactivated, the
 *     harness must be restored from archive + re-validated first.
 *  2. Pair quality — no watchlisted pair sits at <30% WR / 8+ trades
 *     (the auto-pair-pruning trigger). Already-pruned pairs note them
 *     as a positive signal.
 *  3. Side symmetry (auto-side only) — verifies that auto-side doesn't
 *     produce catastrophic losses on either direction (the CHF/JPY
 *     short trap testing 3 fell into).
 *  4. FTMO fit — mean DD ≤ 8% (≥2% headroom under the 10% limit), mean
 *     return projects to ≥10% target within 6 months.
 *
 * Each check returns severity (pass | caution | fail) and a concise
 * reason. Overall verdict is the worst severity across all checks.
 *
 * Used by both `/api/admin/readiness-check` (admin/curl path) and the
 * `runAlgorithmReadinessCheck` server action (operator UI button).
 */
// CB.H1 pass 11 (2026-06-22): 4 sub-checks + combiner + thresholds
// moved to `./readiness-sub-checks.ts`. Types re-exported for back-compat.
import { timeframeToInterval } from "@/lib/market-data/interval";
import { getCachedPrices, savePricesToCache } from "@/lib/market-data/price-cache";
import { fetchDailyPrices } from "@/lib/market-data/prices";
import { runWalkForward } from "@/lib/market-data/walk-forward";
import { getAllPairStats } from "@/lib/scan/pair-quality";
import type { AlgorithmRules } from "@/types/algorithm";
import {
  combineSeverity,
  ftmoFitCheck,
  pairQualityCheck,
  sideSymmetryCheck,
  walkForwardCheck,
  type ReadinessCheckResult,
  type ReadinessSeverity,
  type WalkForwardSummary,
} from "./readiness-sub-checks";
import type { SupabaseClient } from "@supabase/supabase-js";

export type { ReadinessSeverity, ReadinessCheckResult };

export interface ReadinessReport {
  algorithm_id: string;
  algorithm_name: string;
  verdict: ReadinessSeverity;
  checks: ReadinessCheckResult[];
  walk_forward_summary: {
    windows: number;
    mean_win_rate: number;
    mean_return: number;
    mean_drawdown: number;
    win_rate_of_windows: number;
  };
}

/** Cache shape that WAS written by the archived LLM-trader harness
 *  (`scripts/archive/2026-06-18/llm-trader-walk-forward.ts`) to
 *  `algorithms.llm_walk_forward_cache` when ALGO_ID is provided. The
 *  `summary` block matches `WalkForwardSummary` exactly so we can pass
 *  it straight to `walkForwardCheck` without translation. New caches
 *  won't appear until LLM-trader work is reactivated (Stage 5.0+). */
interface LlmWalkForwardCache {
  generated_at: string;
  provider: string;
  model: string;
  prompt_version: string;
  timeframe: string;
  window_days: number;
  window_count: number;
  end_date: string;
  capital: number;
  summary: WalkForwardSummary;
}

interface ReadinessOptions {
  windowDays?: number;
  stepDays?: number;
}

/** Subset of the `algorithms` row that the readiness check consumes.
 *  Extracted as a named type so the SELECT-columns list, the runtime
 *  cast, and the consumer can drift together rather than the cast living
 *  inline in the loader (CB.M2, 2026-06-22). */
interface ReadinessAlgo {
  rules: AlgorithmRules;
  capital: number;
  user_id: string;
  name: string;
  llm_walk_forward_cache: LlmWalkForwardCache | null;
}

/** Build the walk-forward summary for an LLM-trader algorithm by reading
 *  its cached WF result. Returns null if no cache present (caller emits
 *  a "needs WF run" caution). The cache was populated by the archived
 *  LLM-trader harness; LLM-trader is deferred to roadmap Stage 5.0. */
function llmWalkForwardSummary(
  cache: LlmWalkForwardCache | null
): { wf: WalkForwardSummary; effectiveWindowDays: number } | null {
  if (!cache) return null;
  return {
    wf: cache.summary,
    effectiveWindowDays: cache.window_days,
  };
}

/**
 * Run all readiness checks against an algorithm. The supabase client is
 * the caller's responsibility — admin-client for the cron path, session-
 * scoped client for the UI server action. Either works because every
 * underlying query is keyed on `algorithm_id` (RLS will scope the
 * session client to the owner's rows automatically).
 */
export async function runReadinessCheck(
  supabase: SupabaseClient,
  algorithmId: string,
  options: ReadinessOptions = {}
): Promise<{ ok: true; report: ReadinessReport } | { ok: false; error: string }> {
  const windowDays = options.windowDays ?? 180;
  const stepDays = options.stepDays ?? 30;

  const algoRes = await supabase
    .from("algorithms")
    .select("rules, capital, user_id, name, llm_walk_forward_cache")
    .eq("id", algorithmId)
    .single();
  const algo = algoRes.data as ReadinessAlgo | null;
  if (algoRes.error || !algo) return { ok: false, error: "Algorithm not found" };

  const wlRes = await supabase
    .from("algorithm_watchlist")
    .select("ticker")
    .eq("algorithm_id", algorithmId);
  const tickers = ((wlRes.data ?? []) as { ticker: string }[]).map((r) => r.ticker.toUpperCase());

  // Walk-forward dispatch: standard pattern-based path OR cached LLM-trader.
  const { wf, wfCheck } = await dispatchWalkForward(algo, tickers, windowDays, stepDays);

  const pairStatsMap = await getAllPairStats(supabase, algorithmId);
  const pairStats = Array.from(pairStatsMap.values());
  const pairCheck = pairQualityCheck(pairStats);

  const sideCheck = sideSymmetryCheck(algo.rules.side);
  const ftmoCheck = ftmoFitCheck(algo.rules);

  const checks = [wfCheck, pairCheck, sideCheck, ftmoCheck];
  const verdict = combineSeverity(checks.map((c) => c.severity));

  return {
    ok: true,
    report: {
      algorithm_id: algorithmId,
      algorithm_name: algo.name,
      verdict,
      checks,
      walk_forward_summary: {
        windows: wf.total_windows,
        mean_win_rate: wf.mean_win_rate,
        mean_return: wf.mean_return,
        mean_drawdown: wf.mean_drawdown,
        win_rate_of_windows: wf.win_rate_of_windows,
      },
    },
  };
}

/** Dispatch the walk-forward check based on whether the algo is LLM-trader
 *  (uses cached WF or returns "DEFERRED" caution) or pattern-based (runs
 *  fresh runWalkForward against fetched price bars). */
async function dispatchWalkForward(
  algo: ReadinessAlgo,
  tickers: string[],
  windowDays: number,
  stepDays: number
): Promise<{ wf: WalkForwardSummary; wfCheck: ReadinessCheckResult }> {
  const isLlmTrader = algo.rules.llm_trader?.enabled === true;
  if (isLlmTrader) {
    const llm = llmWalkForwardSummary(algo.llm_walk_forward_cache);
    if (!llm) {
      const wf: WalkForwardSummary = {
        total_windows: 0,
        mean_win_rate: 0,
        mean_return: 0,
        mean_drawdown: 0,
        win_rate_of_windows: 0,
        windows: [],
      };
      const wfCheck: ReadinessCheckResult = {
        name: "walk_forward_stability",
        severity: "caution",
        reason:
          "LLM-trader readiness is DEFERRED. The walk-forward harness was archived 2026-06-18 — LLM-trader work resumes at roadmap Stage 5.0 / Phase D.4. Until then, this algo can't be readiness-checked.",
        evidence: { llm_trader: true, cache_present: false },
      };
      return { wf, wfCheck };
    }
    return { wf: llm.wf, wfCheck: walkForwardCheck(llm.wf, algo.capital, llm.effectiveWindowDays) };
  }
  const pricesByTicker = await loadPricesForTickers(tickers, algo.rules.timeframe);
  const wf = runWalkForward(algo.rules, pricesByTicker, algo.capital, {
    testWindowDays: windowDays,
    stepDays,
  });
  return { wf, wfCheck: walkForwardCheck(wf, algo.capital, windowDays) };
}

/** Load price bars for each watchlist ticker into a Map for runWalkForward.
 *  Cache hit fast-path; fetch fallback; skip tickers whose data fetch
 *  fails or returns <30 bars (too thin for walk-forward windows). */
async function loadPricesForTickers(
  tickers: string[],
  timeframe: string
): Promise<Map<string, Awaited<ReturnType<typeof fetchDailyPrices>>>> {
  const interval = timeframeToInterval(timeframe);
  const pricesByTicker = new Map<string, Awaited<ReturnType<typeof fetchDailyPrices>>>();
  for (const ticker of tickers) {
    let prices = await getCachedPrices(ticker, "full", interval);
    if (!prices) {
      try {
        prices = await fetchDailyPrices(ticker, "full", interval);
        savePricesToCache(ticker, "full", prices, interval).catch(() => {});
      } catch {
        continue;
      }
    }
    if (prices && prices.length >= 30) pricesByTicker.set(ticker, prices);
  }
  return pricesByTicker;
}
