/**
 * Admin endpoint: close every open paper position for a given algorithm AND
 * mirror the close to the broker via MetaApi. Bearer-auth guarded by the
 * same CRON_SECRET as the cron route.
 *
 * Usage:
 *   curl -X POST -H "Authorization: Bearer $CRON_SECRET" \
 *     "http://localhost:3000/api/admin/flatten-algo?id=<algorithm_id>"
 */
import { NextResponse } from "next/server";
import {
  closePosition as metaClose,
  type MetaApiRegion,
} from "@/lib/brokers/metaapi";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

interface BrokerConn {
  api_token: string;
  account_id: string;
  region: MetaApiRegion;
}

interface PosRow {
  id: string;
  ticker: string;
  entry_price: number;
  broker_position_id: string | null;
}

export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 500 });
  }
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const algoId = url.searchParams.get("id");
  if (!algoId) {
    return NextResponse.json({ error: "missing ?id=<algorithm_id>" }, { status: 400 });
  }

  const supabase = createAdminClient();

  const algoRes = await supabase
    .from("algorithms")
    .select("broker_connection_id")
    .eq("id", algoId)
    .single();
  const algo = algoRes.data as { broker_connection_id: string | null } | null;
  if (!algo?.broker_connection_id) {
    return NextResponse.json({ error: "no broker connection on algorithm" }, { status: 404 });
  }

  const connRes = await supabase
    .from("broker_connections")
    .select("api_token, account_id, region")
    .eq("id", algo.broker_connection_id)
    .single();
  const conn = connRes.data as unknown as BrokerConn | null;
  if (!conn) {
    return NextResponse.json({ error: "broker connection not found" }, { status: 404 });
  }

  const { data: positions } = await supabase
    .from("paper_positions")
    .select("id, ticker, entry_price, broker_position_id")
    .eq("algorithm_id", algoId)
    .eq("status", "open");

  const list = (positions ?? []) as PosRow[];
  const results: { ticker: string; broker_position_id: string | null; status: string }[] = [];

  for (const pos of list) {
    let status = "paper-only";
    if (pos.broker_position_id) {
      try {
        await metaClose(conn.api_token, conn.account_id, conn.region, pos.broker_position_id);
        status = "broker-closed";
      } catch (err) {
        status = `broker-failed: ${err instanceof Error ? err.message : "unknown"}`;
      }
    }
    const closeUpdate = {
      status: "closed",
      exit_price: pos.entry_price,
      unrealized_pnl: 0,
      realized_pnl: 0,
      exit_reason: "manual",
      closed_at: new Date().toISOString(),
    };
    await supabase
      .from("paper_positions")
      // Admin client has no generated types — cast through unknown.
      .update(closeUpdate as unknown as never)
      .eq("id", pos.id);

    results.push({ ticker: pos.ticker, broker_position_id: pos.broker_position_id, status });
  }

  return NextResponse.json({ flattened: list.length, results });
}
