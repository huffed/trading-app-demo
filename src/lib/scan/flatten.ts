/**
 * Shared "flatten everything for an algorithm" routine. Used by:
 *  - the admin /api/admin/flatten-algo escape hatch
 *  - the daily-loss-limit halt path that fires inside scanAlgorithm
 *
 * Closes the broker side via MetaApi and the paper side in one pass. The
 * paper update happens regardless of broker outcome — even if the broker
 * call fails (network, already-closed, etc.) we still mark the paper
 * position closed so analytics + reconciliation stay consistent.
 */
import {
  closePosition as metaClose,
  type MetaApiRegion,
} from "@/lib/brokers/metaapi";
import type { SupabaseClient } from "@supabase/supabase-js";

interface BrokerConn {
  api_token: string;
  account_id: string;
  region: MetaApiRegion;
}

interface PosRow {
  id: string;
  ticker: string;
  entry_price: number;
  current_price: number | null;
  realized_pnl: number | null;
  unrealized_pnl: number | null;
  broker_position_id: string | null;
}

export interface FlattenResult {
  ticker: string;
  broker_position_id: string | null;
  status: string;
}

/**
 * Close every open paper position for an algorithm AND mirror the close to
 * the broker. Returns one entry per closed position with a status string
 * indicating broker-closed / broker-failed / paper-only.
 */
export async function flattenAlgorithmPositions(
  supabase: SupabaseClient,
  algorithmId: string,
  exitReason: string = "manual"
): Promise<FlattenResult[]> {
  const algoRes = await supabase
    .from("algorithms")
    .select("broker_connection_id")
    .eq("id", algorithmId)
    .single();
  const algo = algoRes.data as { broker_connection_id: string | null } | null;

  let conn: BrokerConn | null = null;
  if (algo?.broker_connection_id) {
    const connRes = await supabase
      .from("broker_connections")
      .select("api_token, account_id, region")
      .eq("id", algo.broker_connection_id)
      .single();
    conn = connRes.data as unknown as BrokerConn | null;
  }

  const { data: positions } = await supabase
    .from("paper_positions")
    .select("id, ticker, entry_price, current_price, realized_pnl, unrealized_pnl, broker_position_id")
    .eq("algorithm_id", algorithmId)
    .eq("status", "open");

  const list = (positions ?? []) as PosRow[];
  const results: FlattenResult[] = [];

  for (const pos of list) {
    let status = "paper-only";
    if (pos.broker_position_id && conn) {
      try {
        await metaClose(conn.api_token, conn.account_id, conn.region, pos.broker_position_id);
        status = "broker-closed";
      } catch (err) {
        status = `broker-failed: ${err instanceof Error ? err.message : "unknown"}`;
      }
    }

    // Close paper side at the last known current price so realized_pnl is
    // honest. Falls back to entry_price (zero P&L) if we never got a tick.
    const exitPrice = pos.current_price ?? pos.entry_price;
    const realized = pos.unrealized_pnl ?? 0;
    const closeUpdate = {
      status: "closed",
      exit_price: exitPrice,
      unrealized_pnl: 0,
      realized_pnl: realized,
      exit_reason: exitReason,
      closed_at: new Date().toISOString(),
    };
    await supabase
      .from("paper_positions")
      .update(closeUpdate as unknown as never)
      .eq("id", pos.id);

    results.push({ ticker: pos.ticker, broker_position_id: pos.broker_position_id, status });
  }

  return results;
}
