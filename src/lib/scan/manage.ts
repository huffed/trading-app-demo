/**
 * Manage-positions tick — walks every open paper position across active
 * algorithms and runs the exit-trigger check using a fresh live quote.
 * Skips entry evaluation entirely so it can run at a higher cadence than
 * the hourly scan without burning the entry-side compute or quote budget.
 *
 * Why this exists separately:
 *   - Hourly scan is fine for entries — bar-close evaluation aligns with
 *     bar boundaries on 1h/4h forex strategies.
 *   - Exits can fire any time inside the bar (price gaps through SL/TP,
 *     intra-bar signal exit). Waiting 59 minutes for the next scan can
 *     give back significant P&L.
 *   - Funded broker accounts have broker-side SL/TP attached at entry, so
 *     they're already protected on price-based exits. This tick covers
 *     the gap on (a) paper-only algos and (b) signal-based exits which
 *     can't be expressed as broker stop orders.
 *
 * Cost: scales with the COUNT of open positions, not the watchlist. With
 * zero open positions this tick is a no-op (single Supabase query and
 * exit). One batch quote call per algo on the tickers that have open
 * positions; cached bar reads from Supabase price_cache for the technical
 * exit conditions.
 */
import { logger } from "@/lib/logger";
import { timeframeToInterval } from "@/lib/market-data/interval";
import { getCachedPrices, savePricesToCache } from "@/lib/market-data/price-cache";
import { fetchDailyPrices, getFreshPricesForScan } from "@/lib/market-data/prices";
import { fetchBatchQuotes } from "@/lib/market-data/twelve-data";
import type { PriceBar } from "@/lib/market-data/types";
import type { Tables } from "@/lib/supabase/database.types";
import type { PaperPosition, PositionEvent } from "@/types/position";
// CB.H1 (2026-06-22): extracted broker-position sync helpers so the sync
// logic is unit-testable + manage.ts drops below the 300-LOC cap.
import {
  reconcileMissingBrokerPosition,
  syncBrokerUnrealizedPnl,
} from "./broker-position-sync";
import {
  reconcileBrokerRealizedPnl,
  reconcileOrphanBrokerRealized,
} from "./broker-truth-sync";
import { manageExistingPosition, type AlgoForPositionMgmt } from "./engine";
import { resolveBrokerContext } from "./live-execution";
import { backfillClosedTradeOutcomes } from "./llm-trader-audit";
import type { SupabaseClient } from "@supabase/supabase-js";

// Re-export for back-compat: external callers (scripts/reconcile-broker-close.ts
// per the original docstring) may continue to import from manage.ts.
export { reconcileMissingBrokerPosition };

export interface ManageResult {
  algorithm_id: string;
  algorithm_name: string;
  positions_inspected: number;
  positions_closed: number;
  positions_updated: number;
  closed_details: PositionEvent[];
  errors: { ticker: string; error: string }[];
}

type AlgoForManage = AlgoForPositionMgmt &
  Pick<Tables<"algorithms">, "user_id" | "live_trading_enabled" | "broker_connection_id">;

/** Fetch bars for a ticker. Uses getFreshPricesForScan so the manage
 *  tick gets the same just-closed bar treatment as the scan engine —
 *  intraday positions are managed on bar-close logic (SL, TP, LLM
 *  exits), so reading a stale tail can cause a miss or a phantom hit. */
async function loadBars(
  ticker: string,
  interval: ReturnType<typeof timeframeToInterval>
): Promise<PriceBar[] | null> {
  try {
    const prices = await getFreshPricesForScan(ticker, "full", interval);
    return prices.length >= 10 ? prices : null;
  } catch (err) {
    // CB.M7.b (2026-06-20): warn-on-swallow so a price-provider outage
    // surfaces in logs. Caller treats null as "skip this tick".
    logger.warn("manage", `loadBars(${ticker}, ${interval}) failed`, err);
    return null;
  }
}

/** Fetch a daily series for higher-timeframe pattern conditions
 *  (daily_bias). Skipped when the algo's primary TF is already 1day. */
async function loadDailyBars(
  ticker: string,
  interval: ReturnType<typeof timeframeToInterval>
): Promise<PriceBar[] | null> {
  if (interval === "1day") return null;
  let dailyBars = await getCachedPrices(ticker, "full", "1day");
  if (!dailyBars) {
    try {
      dailyBars = await fetchDailyPrices(ticker, "full", "1day");
      savePricesToCache(ticker, "full", dailyBars, "1day").catch(() => {});
    } catch (err) {
      // CB.M7.b (2026-06-20): warn-on-swallow — daily-bar fetch failure
      // silently skips higher-TF pattern conditions; surface in logs.
      logger.warn("manage", `loadDailyBars(${ticker}) failed`, err);
      return null;
    }
  }
  return dailyBars;
}

// CB.H1 (2026-06-22): `syncBrokerUnrealizedPnl` + `reconcileMissingBrokerPosition`
// extracted to `./broker-position-sync.ts` so the sync logic is unit-testable
// independently of the manage-cron orchestrator. See top-of-file import.

async function manageAlgorithm(
  supabase: SupabaseClient,
  algo: AlgoForManage,
  positions: PaperPosition[]
): Promise<ManageResult> {
  const result: ManageResult = {
    algorithm_id: algo.id,
    algorithm_name: algo.name,
    positions_inspected: positions.length,
    positions_closed: 0,
    positions_updated: 0,
    closed_details: [],
    errors: [],
  };

  const tickers = Array.from(new Set(positions.map((p) => p.ticker)));
  let liveQuotes = new Map<string, number>();
  try {
    liveQuotes = await fetchBatchQuotes(tickers);
  } catch {
    // Fall back to last bar close inside manageExistingPosition.
  }

  const interval = timeframeToInterval(algo.rules.timeframe);
  const brokerCtx = await resolveBrokerContext(
    supabase,
    algo.user_id,
    algo.broker_connection_id ?? null,
    algo.live_trading_enabled ?? false
  );

  // Sync broker-reported unrealized P&L before the exit-trigger loop —
  // fresh-as-possible read for the UI to display. Then pick up any
  // closed positions whose broker deal record wasn't available at exit
  // time. Both no-op without broker context.
  await syncBrokerUnrealizedPnl(supabase, brokerCtx, positions);
  if (brokerCtx) await reconcileBrokerRealizedPnl(supabase, brokerCtx, algo.id);

  for (const ticker of tickers) {
    try {
      const prices = await loadBars(ticker, interval);
      if (!prices) {
        result.errors.push({ ticker, error: "Not enough price data" });
        continue;
      }
      const closes = prices.map((p) => p.close);
      const dailyBars = await loadDailyBars(ticker, interval);
      const livePrice = liveQuotes.get(ticker.toUpperCase()) ?? null;
      const positionsForTicker = positions.filter((p) => p.ticker === ticker);

      for (const position of positionsForTicker) {
        const r = await manageExistingPosition(
          supabase,
          algo.user_id,
          algo,
          ticker,
          position,
          prices,
          closes,
          livePrice,
          brokerCtx,
          dailyBars
        );
        result.positions_closed += r.closed;
        result.positions_updated += r.updated;
        if (r.closeEvent) result.closed_details.push(r.closeEvent);
      }
    } catch (err) {
      result.errors.push({
        ticker,
        error: err instanceof Error ? err.message : "Unknown error",
      });
    }
  }

  return result;
}

/**
 * Walk every active algorithm with at least one open paper position and
 * run the exit-trigger check on each. Returns one ManageResult per algo
 * (algos with zero open positions are excluded entirely so the response
 * stays focused on what was actually inspected).
 */
export async function manageActiveAlgorithms(
  supabase: SupabaseClient
): Promise<ManageResult[]> {
  // Pull all open positions + their parent algo metadata in one round-trip.
  // E2.25.i F1: scope to OPERATOR_USER_ID when set (single-operator
  // invariant — a stranger's positions must not be managed on the
  // operator's broker keys). Unset = legacy behaviour for dev/CI.
  const operatorId = process.env.OPERATOR_USER_ID;
  let query = supabase
    .from("paper_positions")
    .select(
      "*, algorithms!inner(id, user_id, name, rules, status, live_trading_enabled, broker_connection_id)"
    )
    .eq("status", "open")
    .eq("algorithms.status", "active");
  if (operatorId) query = query.eq("user_id", operatorId);
  const { data, error } = await query;

  if (error) {
    logger.error("manage-positions", "Failed to load open positions", error);
    return [];
  }

  const rows = (data ?? []) as Array<
    PaperPosition & {
      algorithms: AlgoForManage & { status: string };
    }
  >;

  // Group positions by algorithm id so we can batch the broker-context
  // lookup + quote fetch per algo.
  const byAlgo = new Map<string, { algo: AlgoForManage; positions: PaperPosition[] }>();
  for (const row of rows) {
    const algo = row.algorithms;
    const entry = byAlgo.get(algo.id) ?? { algo, positions: [] };
    entry.positions.push(row);
    byAlgo.set(algo.id, entry);
  }

  const results: ManageResult[] = [];
  for (const { algo, positions } of byAlgo.values()) {
    results.push(await manageAlgorithm(supabase, algo, positions));
  }

  // Deferred broker-truth pass for algos that have NO open positions
  // (those are skipped above) but still have closed positions where
  // executeLiveExit couldn't capture the broker deal at exit time.
  // Idempotent + best-effort — never blocks the manage cycle.
  try {
    await reconcileOrphanBrokerRealized(supabase, new Set(byAlgo.keys()));
  } catch (err) {
    logger.warn("manage-positions", "broker realized reconciliation failed", {
      error: err instanceof Error ? err.message : "unknown",
    });
  }

  // Backfill trade_outcome on llm_decisions rows linked to positions that
  // have closed since the last tick. Idempotent + best-effort — never
  // blocks the manage cycle on audit-table updates.
  try {
    await backfillClosedTradeOutcomes(supabase);
  } catch (err) {
    logger.warn("manage-positions", "trade outcome backfill failed", {
      error: err instanceof Error ? err.message : "unknown",
    });
  }

  return results;
}
