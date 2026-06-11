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
import { getBrokerAdapter } from "@/lib/brokers/registry";
import type { BrokerConnection } from "@/lib/brokers/types";
import { logActivity } from "@/lib/scan/helpers";
import type { Tables } from "@/lib/supabase/database.types";
import type { SupabaseClient } from "@supabase/supabase-js";

type PosRow = Pick<
  Tables<"paper_positions">,
  | "id"
  | "user_id"
  | "ticker"
  | "entry_price"
  | "current_price"
  | "realized_pnl"
  | "unrealized_pnl"
  | "broker_position_id"
>;

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

  // Look up the broker connection + adapter once. If the algo isn't
  // wired to a broker (paper-only) or the provider has no adapter
  // registered, we still close paper positions but skip the broker call.
  let conn: BrokerConnection | null = null;
  let adapter: ReturnType<typeof getBrokerAdapter> = null;
  if (algo?.broker_connection_id) {
    const connRes = await supabase
      .from("broker_connections")
      .select(
        "id, user_id, provider, api_token, account_id, region, refresh_token, token_expires_at, account_login"
      )
      .eq("id", algo.broker_connection_id)
      .single();
    conn = (connRes.data as BrokerConnection | null) ?? null;
    if (conn) adapter = getBrokerAdapter(conn.provider);
  }

  const { data: positions } = await supabase
    .from("paper_positions")
    .select(
      "id, user_id, ticker, entry_price, current_price, realized_pnl, unrealized_pnl, broker_position_id"
    )
    .eq("algorithm_id", algorithmId)
    .eq("status", "open");

  const list = (positions ?? []) as PosRow[];
  const results: FlattenResult[] = [];

  for (const pos of list) {
    let status = "paper-only";
    if (pos.broker_position_id && conn && adapter) {
      try {
        await adapter.closePosition(conn, pos.broker_position_id);
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
    // status guard: if a manage/scan tick closed this row mid-flatten,
    // keep its close record (exit_reason, realized P&L) — don't overwrite.
    // The broker close above still ran regardless: flatten is the
    // emergency hammer and a duplicate broker close fails harmlessly in
    // the catch.
    await supabase
      .from("paper_positions")
      .update(closeUpdate as unknown as never)
      .eq("id", pos.id)
      .eq("status", "open");

    // Audit the broker-close outcome. Before this, flatten's
    // broker-closed / broker-failed result existed only in the HTTP
    // response — the 2026-05-18 flatten's broker outcome was unrecoverable
    // during the 2026-06-10 review because nothing persisted it.
    await logActivity(supabase, pos.user_id, {
      algorithm_id: algorithmId,
      position_id: pos.id,
      event_type:
        status === "broker-closed"
          ? "live_order_closed"
          : status.startsWith("broker-failed")
            ? "live_order_close_failed"
            : "position_closed",
      ticker: pos.ticker,
      details: {
        source: "flatten",
        flatten_status: status,
        exit_reason: exitReason,
        exit_price: exitPrice,
        realized_pnl: realized,
      },
    });

    results.push({ ticker: pos.ticker, broker_position_id: pos.broker_position_id, status });
  }

  return results;
}
