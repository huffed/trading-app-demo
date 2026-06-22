/**
 * Deferred broker-truth pass for paper_positions that our engine closed
 * but where the broker's deal record hadn't settled yet at exit time
 * (typical MetaApi lag <60s, occasionally longer).
 *
 * `executeLiveExit` leaves `broker_realized_synced_at` NULL when it
 * can't fetch the deal at close time. This module is the retry layer:
 * the manage cron runs `reconcileBrokerRealizedPnl` per algo that has
 * open positions, and `reconcileOrphanBrokerRealized` covers algos
 * that no longer have any open positions but still have closed rows
 * pending broker truth.
 *
 * Without this, the UI would keep showing a hybrid number (broker
 * entry fill × our local exit price), which differs from the broker's
 * true realized P&L by the close-side spread + commission + swap.
 */
import type { BrokerConnection } from "@/lib/brokers/types";
import { logActivity } from "./helpers";
import { resolveBrokerContext } from "./live-execution";
import type { SupabaseClient } from "@supabase/supabase-js";

interface BrokerCtx {
  adapter: {
    fetchClosedDealForPosition?: (
      conn: BrokerConnection,
      positionId: string
    ) => Promise<{ price: number; realizedPnl: number; closedAt: string } | null>;
  };
  conn: BrokerConnection;
}

/** Window beyond which a deal is considered unrecoverable. Anything
 *  closed-but-unsynced past this point keeps its provisional broker
 *  values rather than retrying forever. */
const RECONCILE_WINDOW_MS = 7 * 86_400_000;

/**
 * Walk closed paper_positions for the given algorithm where broker
 * truth hasn't been written yet, and try to fetch the deal record from
 * the broker. On success, overwrite `broker_close_price` + `realized_pnl`
 * with broker truth and stamp `broker_realized_synced_at`. On null /
 * network failure: leave the row alone for the next tick.
 */
export async function reconcileBrokerRealizedPnl(
  supabase: SupabaseClient,
  brokerCtx: BrokerCtx,
  algorithmId: string
): Promise<void> {
  const fetcher = brokerCtx.adapter.fetchClosedDealForPosition;
  if (!fetcher) return;
  const cutoff = new Date(Date.now() - RECONCILE_WINDOW_MS).toISOString();
  const { data, error } = await supabase
    .from("paper_positions")
    .select("id, user_id, ticker, broker_position_id, closed_at")
    .eq("algorithm_id", algorithmId)
    .eq("status", "closed")
    .is("broker_realized_synced_at", null)
    .not("broker_position_id", "is", null)
    .gte("closed_at", cutoff);
  if (error || !data || data.length === 0) return;
  for (const row of data) {
    if (!row.broker_position_id) continue;
    let closed: Awaited<ReturnType<typeof fetcher>> = null;
    try {
      closed = await fetcher.call(brokerCtx.adapter, brokerCtx.conn, row.broker_position_id);
    } catch {
      continue;
    }
    if (!closed) continue;
    await supabase
      .from("paper_positions")
      .update({
        broker_close_price: closed.price,
        realized_pnl: closed.realizedPnl,
        broker_realized_synced_at: new Date().toISOString(),
      })
      .eq("id", row.id);
    await logActivity(supabase, row.user_id, {
      algorithm_id: algorithmId,
      position_id: row.id,
      event_type: "broker_realized_synced",
      ticker: row.ticker,
      details: {
        broker_position_id: row.broker_position_id,
        broker_close_price: closed.price,
        broker_realized_pnl: closed.realizedPnl,
        closed_at: closed.closedAt,
      },
    });
  }
}

/**
 * Run `reconcileBrokerRealizedPnl` for every active algorithm that has
 * closed positions still missing broker truth, skipping algos already
 * touched by the open-position loop this tick.
 */
export async function reconcileOrphanBrokerRealized(
  supabase: SupabaseClient,
  alreadyHandled: Set<string>
): Promise<void> {
  const cutoff = new Date(Date.now() - RECONCILE_WINDOW_MS).toISOString();
  const { data, error } = await supabase
    .from("paper_positions")
    .select(
      "algorithm_id, algorithms!inner(id, user_id, status, live_trading_enabled, broker_connection_id)"
    )
    .eq("status", "closed")
    .is("broker_realized_synced_at", null)
    .not("broker_position_id", "is", null)
    .gte("closed_at", cutoff)
    .eq("algorithms.status", "active");
  if (error || !data) return;
  type AlgoRow = {
    algorithm_id: string;
    algorithms: {
      id: string;
      user_id: string;
      status: string;
      live_trading_enabled: boolean | null;
      broker_connection_id: string | null;
    };
  };
  const seen = new Set<string>();
  const algos: AlgoRow["algorithms"][] = [];
  // CB.H3.c (2026-06-20): per-row narrow + !inner-join unwrap. Supabase
  // typegen returns the `algorithms` relation as `T | T[] | null` even
  // with !inner (typegen limitation); unwrap to single object.
  for (const row of data) {
    if (alreadyHandled.has(row.algorithm_id)) continue;
    if (seen.has(row.algorithm_id)) continue;
    seen.add(row.algorithm_id);
    const a = Array.isArray(row.algorithms) ? row.algorithms[0] : row.algorithms;
    if (a) algos.push(a as AlgoRow["algorithms"]);
  }
  for (const algo of algos) {
    const brokerCtx = await resolveBrokerContext(
      supabase,
      algo.user_id,
      algo.broker_connection_id,
      algo.live_trading_enabled ?? false
    );
    if (!brokerCtx) continue;
    await reconcileBrokerRealizedPnl(supabase, brokerCtx, algo.id);
  }
}
