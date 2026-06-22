/**
 * Paper trading scan engine — evaluates active algorithms against their
 * watchlist tickers and opens/closes virtual positions.
 *
 * Uses the SHARED condition-evaluation module (lib/conditions/evaluate)
 * to guarantee consistency between backtested and live-scanned signals.
 * The shared module is neutral — neither live scan nor backtest engine
 * depends on the other (CB.C6 fix 2026-06-20).
 */
import { timeframeToInterval } from "@/lib/market-data/interval";
import { getCachedPrices, savePricesToCache } from "@/lib/market-data/price-cache";
import { fetchDailyPrices } from "@/lib/market-data/prices";
import { fetchBatchQuotes } from "@/lib/market-data/twelve-data";
import type { PriceBar } from "@/lib/market-data/types";
import type { AlgorithmRules } from "@/types/algorithm";
import type { PaperPosition, PositionEvent } from "@/types/position";
import { maybeHaltOnDailyLoss, maybeWarnOnDailyLoss } from "./daily-halt";
import { DEFAULT_DRIFT_CONFIG, detectDrift, executeDriftHalt } from "./drift-detector";
import {
  manageExistingPosition,
  type AlgoForPositionMgmt,
} from "./engine-position-mgmt";
import { processTicker } from "./engine-process-ticker";
import { checkExitTrigger } from "./exit-trigger";
import { logActivity } from "./helpers";
import { resolveBrokerContext } from "./live-execution";
import { evaluateAndPrune } from "./pair-quality";
import type { SupabaseClient } from "@supabase/supabase-js";

// CB.H1 pass 17 (2026-06-22): position-management + per-ticker processing
// + exit-trigger extracted. Re-exports preserve external import paths.
export { checkExitTrigger, manageExistingPosition, type AlgoForPositionMgmt };

// ---- Types ----

export interface ScanResult {
  algorithm_id: string;
  algorithm_name: string;
  tickers_scanned: number;
  positions_opened: number;
  positions_closed: number;
  positions_updated: number;
  opened_details: PositionEvent[];
  closed_details: PositionEvent[];
  errors: { ticker: string; error: string }[];
}

interface AlgorithmWithWatchlist {
  id: string;
  name: string;
  description: string;
  rules: AlgorithmRules;
  capital: number;
  status: string;
  algorithm_watchlist: { ticker: string; name: string; auto_paused?: boolean }[];
  live_trading_enabled?: boolean;
  broker_connection_id?: string | null;
}

// ---- Core scan ----

/**
 * Scan a single algorithm against all its watchlist tickers.
 */
export async function scanAlgorithm(
  supabase: SupabaseClient,
  userId: string,
  algo: AlgorithmWithWatchlist,
  options: { force?: boolean } = {}
): Promise<ScanResult> {
  const force = options.force ?? false;
  const result: ScanResult = {
    algorithm_id: algo.id,
    algorithm_name: algo.name,
    tickers_scanned: 0,
    positions_opened: 0,
    positions_closed: 0,
    positions_updated: 0,
    opened_details: [],
    closed_details: [],
    errors: [],
  };

  // Skip auto-paused tickers; the pair-quality evaluator marks bad pairs.
  const tickers = algo.algorithm_watchlist.filter((w) => !w.auto_paused).map((w) => w.ticker);
  if (tickers.length === 0) return result;

  await logActivity(supabase, userId, {
    algorithm_id: algo.id,
    event_type: "scan_started",
    details: { tickers_count: tickers.length },
  });

  if (await maybeHaltOnDailyLoss(supabase, userId, algo)) return result;
  // Soft warning at 40% of way to DLL. Idempotent per UTC day.
  await maybeWarnOnDailyLoss(supabase, userId, algo);

  const positions = await loadOpenPositions(supabase, userId, algo.id);
  const liveQuotes = await fetchLiveQuotesSafely(tickers);
  const interval = timeframeToInterval(algo.rules.timeframe);
  const brokerCtx = await resolveBrokerContext(
    supabase,
    userId,
    algo.broker_connection_id ?? null,
    algo.live_trading_enabled ?? false
  );
  const dxyBars = await loadDxyBarsIfNeeded(algo);
  const intermarket = await loadIntermarketIfNeeded(algo);

  for (const ticker of tickers) {
    await processTicker(
      supabase,
      userId,
      algo,
      ticker,
      positions,
      result,
      liveQuotes,
      interval,
      brokerCtx,
      dxyBars,
      intermarket,
      force
    );
  }

  await logActivity(supabase, userId, {
    algorithm_id: algo.id,
    event_type: "scan_completed",
    details: {
      tickers_scanned: result.tickers_scanned,
      positions_opened: result.positions_opened,
      positions_closed: result.positions_closed,
      positions_updated: result.positions_updated,
      errors_count: result.errors.length,
    },
  });

  // Re-evaluate pair quality + drift only when something closed —
  // stats don't move on quiet scans, so paying for the query each tick
  // is wasted.
  if (result.positions_closed > 0) {
    await runPostCloseAnalytics(supabase, userId, algo);
  }

  await supabase
    .from("algorithms")
    .update({ last_scanned_at: new Date().toISOString() })
    .eq("id", algo.id);
  return result;
}

/** Load every open `paper_positions` row for the algo. RLS-scoped. */
async function loadOpenPositions(
  supabase: SupabaseClient,
  userId: string,
  algoId: string
): Promise<PaperPosition[]> {
  const { data } = await supabase
    .from("paper_positions")
    .select("*")
    .eq("algorithm_id", algoId)
    .eq("user_id", userId)
    .eq("status", "open");
  return (data ?? []) as PaperPosition[];
}

/** Batch live quotes for all watchlist tickers. Failure falls back
 *  to using daily closes (per-ticker handled downstream). */
async function fetchLiveQuotesSafely(tickers: string[]): Promise<Map<string, number>> {
  try {
    return await fetchBatchQuotes(tickers);
  } catch {
    return new Map();
  }
}

/** Fetch EUR/USD 1h bars ONCE per scan when DXY filter OR LLM-trader is
 *  on. Shared across all tickers; cached via standard price-cache TTL.
 *  The LLM-trader prompt uses these for the DXY directional row;
 *  without them the LLM saw "DXY: n/a" since activation. */
async function loadDxyBarsIfNeeded(algo: AlgorithmWithWatchlist): Promise<PriceBar[] | null> {
  const wantsDxy = algo.rules.dxy_filter?.enabled || algo.rules.llm_trader?.enabled;
  if (!wantsDxy) return null;
  let dxyBars = await getCachedPrices("EUR/USD", "full", "1h");
  if (!dxyBars) {
    try {
      dxyBars = await fetchDailyPrices("EUR/USD", "full", "1h");
      savePricesToCache("EUR/USD", "full", dxyBars, "1h").catch(() => {});
    } catch {
      dxyBars = null;
    }
  }
  return dxyBars;
}

/** Intermarket series (silver / 10Y yield / VIX) for LLM-trader's
 *  prompt context. Only fetched for commodity algos with llm_trader
 *  enabled. Each tryFetch catches its own failure so one missing series
 *  doesn't blank the whole block. Cost: ~3 unmetered-provider calls. */
async function loadIntermarketIfNeeded(
  algo: AlgorithmWithWatchlist
): Promise<{ silver?: PriceBar[]; yield10y?: PriceBar[]; vix?: PriceBar[] } | null> {
  if (!(algo.rules.llm_trader?.enabled && algo.rules.asset_class === "commodity")) {
    return null;
  }
  const tryFetch = async (ticker: string): Promise<PriceBar[] | undefined> => {
    try {
      let bars = await getCachedPrices(ticker, "full", "1day");
      if (!bars) {
        bars = await fetchDailyPrices(ticker, "full", "1day");
        savePricesToCache(ticker, "full", bars, "1day").catch(() => {});
      }
      return bars && bars.length > 0 ? bars : undefined;
    } catch {
      return undefined;
    }
  };
  const [silver, yield10y, vix] = await Promise.all([
    tryFetch("XAG/USD"),
    tryFetch("^TNX"),
    tryFetch("^VIX"),
  ]);
  return { silver, yield10y, vix };
}

/** Post-close housekeeping — pair-quality eval (auto-pause losers) +
 *  drift detector (halt on severe decay vs backtest baseline). Drift
 *  halt disables live_trading_enabled but lets open positions play out
 *  (distinct from DLL force-close). */
async function runPostCloseAnalytics(
  supabase: SupabaseClient,
  userId: string,
  algo: AlgorithmWithWatchlist
): Promise<void> {
  const evals = await evaluateAndPrune(supabase, algo.id);
  for (const e of evals) {
    if (e.pruned && e.reason !== "already_paused") {
      await logActivity(supabase, userId, {
        algorithm_id: algo.id,
        event_type: "pair_auto_paused",
        ticker: e.ticker,
        details: { reason: e.reason, stats: e.stats },
      });
    }
  }
  const algoRow = await supabase
    .from("algorithms")
    .select("backtest_results")
    .eq("id", algo.id)
    .single();
  const baseline = (algoRow.data?.backtest_results ?? null) as
    | import("@/types/algorithm").BacktestResults
    | null;
  const driftConfig = { ...DEFAULT_DRIFT_CONFIG, minLiveWrPct: algo.rules.drift?.min_live_wr_pct };
  const drift = await detectDrift(supabase, algo.id, baseline, driftConfig);
  if (drift.severity !== "none") {
    await logActivity(supabase, userId, {
      algorithm_id: algo.id,
      event_type: drift.severity === "halt" ? "drift_halt" : "drift_warn",
      details: { severity: drift.severity, reason: drift.reason, recent: drift.recent, baseline: drift.baseline },
    });
    if (drift.severity === "halt") {
      await executeDriftHalt(supabase, userId, algo.id, drift);
    }
  }
}
