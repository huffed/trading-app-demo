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
import { fetchDailyPrices } from "@/lib/market-data/prices";
import { fetchBatchQuotes } from "@/lib/market-data/twelve-data";
import type { PriceBar } from "@/lib/market-data/types";
import type { AlgorithmRules } from "@/types/algorithm";
import type { PaperPosition, PositionEvent } from "@/types/position";
import { manageExistingPosition, type AlgoForPositionMgmt } from "./engine";
import { logActivity } from "./helpers";
import { resolveBrokerContext } from "./live-execution";
import type { SupabaseClient } from "@supabase/supabase-js";

export interface ManageResult {
  algorithm_id: string;
  algorithm_name: string;
  positions_inspected: number;
  positions_closed: number;
  positions_updated: number;
  closed_details: PositionEvent[];
  errors: { ticker: string; error: string }[];
}

interface AlgoForManage extends AlgoForPositionMgmt {
  user_id: string;
  rules: AlgorithmRules;
  live_trading_enabled?: boolean | null;
  broker_connection_id?: string | null;
}

/** Fetch bars for a ticker, hitting the price_cache first. Mirrors what
 *  processTicker does inside the scan engine. Returns null when there's
 *  not enough data to evaluate exit conditions safely. */
async function loadBars(
  ticker: string,
  interval: ReturnType<typeof timeframeToInterval>
): Promise<PriceBar[] | null> {
  let prices = await getCachedPrices(ticker, "full", interval);
  if (!prices) {
    try {
      prices = await fetchDailyPrices(ticker, "full", interval);
      savePricesToCache(ticker, "full", prices, interval).catch(() => {});
    } catch {
      return null;
    }
  }
  return prices.length >= 10 ? prices : null;
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
    } catch {
      return null;
    }
  }
  return dailyBars;
}

/**
 * Refresh broker_unrealized_pnl on every paper position that has a
 * broker mirror. One fetchPositions call per algo, then map results by
 * broker_position_id. Best-effort — a broker fetch failure leaves the
 * cached value stale, which is preferable to nulling out a recent good
 * value just because one tick had a network blip.
 */
async function syncBrokerUnrealizedPnl(
  supabase: SupabaseClient,
  brokerCtx: Awaited<ReturnType<typeof resolveBrokerContext>>,
  positions: PaperPosition[]
): Promise<void> {
  if (!brokerCtx) return;
  const mirrored = positions.filter((p) => p.broker_position_id);
  if (mirrored.length === 0) return;
  let brokerPositions: Awaited<ReturnType<typeof brokerCtx.adapter.fetchPositions>>;
  try {
    brokerPositions = await brokerCtx.adapter.fetchPositions(brokerCtx.conn);
  } catch (err) {
    logger.warn(
      "manage-positions",
      "broker fetchPositions failed, leaving broker_unrealized_pnl stale",
      err instanceof Error ? err.message : err
    );
    return;
  }
  const byId = new Map(brokerPositions.map((p) => [String(p.id), p]));
  const syncedAt = new Date().toISOString();
  for (const paper of mirrored) {
    const broker = byId.get(String(paper.broker_position_id));
    if (!broker) {
      // Broker stopped reporting this position. Either (a) it was closed
      // outside our exit logic — typically operator clicked close in the
      // broker UI — or (b) MetaApi has lag and the position will reappear
      // in a moment. Try to fetch the realised close from the broker's
      // history; if found, write it back. If not (lag or unsupported
      // adapter), leave the row alone and retry on the next tick.
      await reconcileMissingBrokerPosition(supabase, brokerCtx, paper);
      continue;
    }
    await supabase
      .from("paper_positions")
      .update({
        broker_unrealized_pnl: Number(broker.profit ?? 0),
        broker_pnl_synced_at: syncedAt,
      })
      .eq("id", paper.id);
  }
}

/**
 * Try to find the realised close of a paper position whose broker mirror
 * stopped reporting. Pulled out so the same logic is reusable from
 * scripts/reconcile-broker-close.ts. No-op when the adapter doesn't
 * implement fetchClosedDealForPosition (cTrader streams deals only).
 */
export async function reconcileMissingBrokerPosition(
  supabase: SupabaseClient,
  brokerCtx: NonNullable<Awaited<ReturnType<typeof resolveBrokerContext>>>,
  paper: PaperPosition
): Promise<void> {
  const fetcher = brokerCtx.adapter.fetchClosedDealForPosition;
  if (!fetcher) return;
  if (!paper.broker_position_id) return;
  const closed = await fetcher.call(
    brokerCtx.adapter,
    brokerCtx.conn,
    paper.broker_position_id
  );
  if (!closed) return;
  await supabase
    .from("paper_positions")
    .update({
      status: "closed",
      exit_price: closed.price,
      exit_reason: "manual",
      realized_pnl: closed.realizedPnl,
      broker_close_price: closed.price,
      broker_unrealized_pnl: 0,
      closed_at: closed.closedAt,
    })
    .eq("id", paper.id)
    .eq("status", "open");
  await logActivity(supabase, paper.user_id, {
    algorithm_id: paper.algorithm_id,
    event_type: "live_order_closed",
    ticker: paper.ticker,
    details: {
      reason: "broker-side close reconciled (manage cron)",
      exit_price: closed.price,
      realized_pnl: closed.realizedPnl,
      closed_at: closed.closedAt,
      broker_position_id: paper.broker_position_id,
    },
  });
}

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
  // fresh-as-possible read for the UI to display, and it has no
  // side-effects on the exit logic itself.
  await syncBrokerUnrealizedPnl(supabase, brokerCtx, positions);

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

  // Heartbeat: one log entry per manage tick that touched ≥1 open
  // position. Lets the operator confirm the 5-min cron is alive even on
  // ticks where nothing closed. Skipped when positions_inspected is 0
  // (manageActiveAlgorithms already filters those out, but defensive).
  if (positions.length > 0) {
    await logActivity(supabase, algo.user_id, {
      algorithm_id: algo.id,
      event_type: "manage_tick",
      details: {
        positions_inspected: result.positions_inspected,
        positions_closed: result.positions_closed,
        positions_updated: result.positions_updated,
        broker_mirrored: positions.filter((p) => p.broker_position_id).length,
        errors_count: result.errors.length,
      },
    });
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
  const { data, error } = await supabase
    .from("paper_positions")
    .select(
      "*, algorithms!inner(id, user_id, name, rules, status, live_trading_enabled, broker_connection_id)"
    )
    .eq("status", "open")
    .eq("algorithms.status", "active");

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
  return results;
}
