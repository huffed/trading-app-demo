/**
 * Backfill broker-truth (broker_close_price + realized_pnl) on closed
 * paper_positions where `executeLiveExit` couldn't capture the broker's
 * deal record at exit time and `broker_realized_synced_at` is still
 * NULL. Same logic as `reconcileBrokerRealizedPnl` — exposed as a
 * one-shot script so the operator can fix existing rows immediately
 * without waiting for the next manage tick.
 *
 * Usage (DRY RUN):
 *   pnpm dlx tsx scripts/backfill-broker-realized.ts
 *
 * Apply changes:
 *   APPLY=1 pnpm dlx tsx scripts/backfill-broker-realized.ts
 *
 * Filter to a specific algorithm:
 *   ALGORITHM_ID=<id> APPLY=1 pnpm dlx tsx scripts/backfill-broker-realized.ts
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

interface PendingRow {
  id: string;
  algorithm_id: string;
  ticker: string;
  side: string;
  broker_position_id: string;
  broker_fill_price: number | null;
  broker_close_price: number | null;
  realized_pnl: number | null;
  closed_at: string;
}

async function main(): Promise<void> {
  const apply = process.env.APPLY === "1" || process.env.APPLY === "true";
  const algorithmId = process.env.ALGORITHM_ID || null;

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );

  let q = supabase
    .from("paper_positions")
    .select(
      "id, algorithm_id, ticker, side, broker_position_id, broker_fill_price, broker_close_price, realized_pnl, closed_at"
    )
    .eq("status", "closed")
    .is("broker_realized_synced_at", null)
    .not("broker_position_id", "is", null);
  if (algorithmId) q = q.eq("algorithm_id", algorithmId);

  const { data, error } = await q;
  if (error) throw new Error(`Query failed: ${error.message}`);
  const rows = (data ?? []) as PendingRow[];
  if (rows.length === 0) {
    console.log("No pending rows. Nothing to backfill.");
    return;
  }
  console.log(`Found ${rows.length} closed position(s) pending broker truth.\n`);

  const algoIds = Array.from(new Set(rows.map((r) => r.algorithm_id)));
  const { data: algos, error: algoErr } = await supabase
    .from("algorithms")
    .select("id, user_id, broker_connection_id, name")
    .in("id", algoIds);
  if (algoErr) throw new Error(`Algorithm lookup failed: ${algoErr.message}`);
  const algoById = new Map((algos ?? []).map((a) => [a.id, a]));

  const connIds = Array.from(
    new Set((algos ?? []).map((a) => a.broker_connection_id).filter((x): x is string => !!x))
  );
  const { data: conns, error: connErr } = await supabase
    .from("broker_connections")
    .select(
      "id, user_id, provider, api_token, account_id, region, refresh_token, token_expires_at, account_login"
    )
    .in("id", connIds);
  if (connErr) throw new Error(`Connection lookup failed: ${connErr.message}`);
  const connById = new Map((conns ?? []).map((c) => [c.id, c as BrokerConnection]));

  for (const row of rows) {
    const algo = algoById.get(row.algorithm_id);
    if (!algo?.broker_connection_id) {
      console.log(`  [skip] ${row.id.slice(0, 8)} ${row.ticker} — no broker connection.`);
      continue;
    }
    const conn = connById.get(algo.broker_connection_id);
    if (!conn) {
      console.log(`  [skip] ${row.id.slice(0, 8)} ${row.ticker} — connection not found.`);
      continue;
    }
    const adapter = getBrokerAdapter(conn.provider);
    if (!adapter?.fetchClosedDealForPosition) {
      console.log(
        `  [skip] ${row.id.slice(0, 8)} ${row.ticker} — adapter ${conn.provider} has no fetchClosedDealForPosition.`
      );
      continue;
    }

    const closed = await adapter
      .fetchClosedDealForPosition(conn, row.broker_position_id)
      .catch((err: unknown) => {
        console.log(
          `  [error] ${row.id.slice(0, 8)} ${row.ticker} — ${err instanceof Error ? err.message : "fetch failed"}`
        );
        return null;
      });
    if (!closed) {
      console.log(
        `  [no-deal] ${row.id.slice(0, 8)} ${row.ticker} — broker has no DEAL_ENTRY_OUT for position ${row.broker_position_id}.`
      );
      continue;
    }

    const oldDisplayedPnl =
      row.broker_fill_price != null && row.broker_close_price != null
        ? null // already had broker numbers (would have been hit only if synced flag was wiped)
        : row.realized_pnl;
    console.log(`  ${row.ticker} ${row.side} (${algo.name}) — ${row.id.slice(0, 8)}`);
    console.log(`    closed_at          : ${row.closed_at}`);
    console.log(`    OLD broker_close   : ${row.broker_close_price ?? "null"}`);
    console.log(`    NEW broker_close   : ${closed.price}`);
    console.log(`    OLD realized_pnl   : ${row.realized_pnl ?? "null"}`);
    console.log(`    NEW realized_pnl   : ${closed.realizedPnl.toFixed(2)} (broker truth)`);
    if (oldDisplayedPnl != null) {
      console.log(
        `    delta vs displayed : ${(closed.realizedPnl - oldDisplayedPnl).toFixed(2)}`
      );
    }

    if (!apply) {
      console.log(`    [DRY RUN]\n`);
      continue;
    }

    const { error: updErr } = await supabase
      .from("paper_positions")
      .update({
        broker_close_price: closed.price,
        realized_pnl: closed.realizedPnl,
        broker_realized_synced_at: new Date().toISOString(),
      })
      .eq("id", row.id);
    if (updErr) {
      console.log(`    [error] update failed: ${updErr.message}\n`);
      continue;
    }
    console.log(`    [APPLIED]\n`);
  }

  if (!apply) {
    console.log("DRY RUN complete. Re-run with APPLY=1 to write changes.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
