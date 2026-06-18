/**
 * Reconcile a paper_position that was closed on the broker side but still
 * shows status='open' in our DB.
 *
 * Why this exists: the manage cron's `syncBrokerUnrealizedPnl` only updates
 * P&L for positions that the broker still reports. When the broker stops
 * reporting a position (because it was closed), the loop silently skips
 * — there's no branch that flips paper_positions.status to 'closed'. So
 * positions closed via the broker UI (rather than via our exit logic) get
 * stranded as 'open' forever. This script is the operational workaround.
 * The manage-cron sync should be fixed in a follow-up PR.
 *
 * Flow: read the paper_position, look up its broker_connection (token /
 * account / region), call MetaApi's `/history-deals/position/{positionId}`
 * endpoint to find the DEAL_ENTRY_OUT (close) deal, write the close back
 * onto the paper_position row.
 *
 * Usage:
 *   POSITION_ID=<paper_positions.id> pnpm dlx tsx scripts/reconcile-broker-close.ts
 *   POSITION_ID=<id> APPLY=1 pnpm dlx tsx scripts/reconcile-broker-close.ts
 */
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import { getBrokerAdapter } from "../src/lib/brokers/registry";
import type { BrokerConnection } from "../src/lib/brokers/types";

{
  try {
    const raw = readFileSync(".env.local", "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (!m) continue;
      const [, k, v] = m;
      if (!process.env[k]) process.env[k] = v.replace(/^['"]|['"]$/g, "");
    }
  } catch {
    /* ignore */
  }
}

interface PaperPosition {
  id: string;
  algorithm_id: string;
  status: string;
  ticker: string;
  side: string;
  entry_price: number;
  broker_position_id: string | null;
}

async function main(): Promise<void> {
  const positionId = process.env.POSITION_ID;
  if (!positionId) throw new Error("POSITION_ID env var required (paper_positions.id)");
  const apply = process.env.APPLY === "1" || process.env.APPLY === "true";

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );

  const { data: posRow, error: posErr } = await supabase
    .from("paper_positions")
    .select("id, algorithm_id, status, ticker, side, entry_price, broker_position_id")
    .eq("id", positionId)
    .single();
  if (posErr || !posRow) throw new Error(`paper_position not found: ${posErr?.message}`);
  const paper = posRow as PaperPosition;

  if (paper.status === "closed") {
    console.log(`Position ${paper.id.slice(0, 8)} already closed in DB — no-op.`);
    return;
  }
  if (!paper.broker_position_id) {
    throw new Error("Paper position has no broker_position_id — cannot reconcile.");
  }

  const { data: algoRow, error: algoErr } = await supabase
    .from("algorithms")
    .select("broker_connection_id")
    .eq("id", paper.algorithm_id)
    .single();
  if (algoErr || !algoRow) throw new Error(`algorithm not found: ${algoErr?.message}`);
  if (!algoRow.broker_connection_id) {
    throw new Error("Algorithm has no broker_connection_id.");
  }

  const { data: connRow, error: connErr } = await supabase
    .from("broker_connections")
    .select("id, user_id, provider, api_token, account_id, region")
    .eq("id", algoRow.broker_connection_id)
    .single();
  if (connErr || !connRow) throw new Error(`broker_connection not found: ${connErr?.message}`);
  const conn = connRow as BrokerConnection;

  const adapter = getBrokerAdapter(conn.provider);
  if (!adapter) throw new Error(`Provider ${conn.provider} not registered.`);
  if (!adapter.fetchClosedDealForPosition) {
    throw new Error(
      `Adapter ${conn.provider} doesn't expose fetchClosedDealForPosition — manual reconciliation not supported.`
    );
  }

  console.log(`Paper position ${paper.id.slice(0, 8)} — ${paper.ticker} ${paper.side}`);
  console.log(`  status            : ${paper.status}`);
  console.log(`  entry_price       : ${paper.entry_price}`);
  console.log(`  broker_position_id: ${paper.broker_position_id}`);
  console.log("");
  console.log(`Calling ${conn.provider}.fetchClosedDealForPosition(${paper.broker_position_id})...`);

  const closed = await adapter.fetchClosedDealForPosition(conn, paper.broker_position_id);
  if (!closed) {
    console.log(
      "Adapter returned null — position may not yet be in broker history (typical lag <60s) or never closed."
    );
    console.log("Re-run in a minute if you confirmed the close on the broker UI.");
    return;
  }

  console.log("");
  console.log("Reconciliation:");
  console.log(`  exit_price        : ${closed.price}`);
  console.log(`  realized_pnl      : ${closed.realizedPnl.toFixed(2)} (profit + swap + commission)`);
  console.log(`  closed_at         : ${closed.closedAt}`);
  console.log(`  exit_reason       : manual`);
  console.log("");

  if (!apply) {
    console.log("DRY RUN — no changes written. Re-run with APPLY=1 to apply.");
    return;
  }

  const { error: updErr } = await supabase
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
  if (updErr) throw new Error(`Update failed: ${updErr.message}`);

  console.log("Applied. paper_position now status=closed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
