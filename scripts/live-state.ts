/**
 * Live-state check — single-shot operator dashboard query.
 *
 * Run before any live activation, prompt migration, or risky operation
 * to verify the current state matches assumptions. Per
 * `feedback_check_active_state.md` (operator memory): "Always query
 * Supabase for what's actually deployed before making strategic
 * claims."
 *
 * Output sections:
 *   - Active algos (which are live, which are paused/disabled)
 *   - Open positions (broker-mirrored vs paper-only divergence)
 *   - Cron heartbeat (when did manage_tick / scan_completed last fire?)
 *   - Recent events (last 24h counts by type)
 *   - Broker sync gaps (closed positions awaiting broker truth sync)
 *   - Recent closed trades (last 5 with realized P&L)
 *
 * Usage:
 *   pnpm dlx tsx scripts/live-state.ts
 *
 * No env vars required — reads from .env.local for Supabase creds.
 */
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";

// Self-load .env.local (same pattern as other scripts here)
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

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !serviceKey) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, serviceKey, {
  auth: { persistSession: false },
});

function section(title: string): void {
  console.log("");
  console.log("=".repeat(78));
  console.log(`  ${title}`);
  console.log("=".repeat(78));
}

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}

function ageMinutes(isoTs: string | null | undefined): string {
  if (!isoTs) return "n/a";
  const min = Math.floor((Date.now() - new Date(isoTs).getTime()) / 60000);
  if (min < 60) return `${min}m ago`;
  if (min < 1440) return `${Math.floor(min / 60)}h ${min % 60}m ago`;
  return `${Math.floor(min / 1440)}d ${Math.floor((min % 1440) / 60)}h ago`;
}

async function main(): Promise<void> {
  console.log(`\n=== LIVE STATE @ ${new Date().toISOString()} ===\n`);

  // 1. Active algos
  section("ACTIVE ALGOS");
  const { data: algos } = await supabase
    .from("algorithms")
    .select("id, name, status, live_trading_enabled, broker_connection_id, updated_at")
    .eq("status", "active")
    .order("name");
  if (!algos || algos.length === 0) {
    console.log("  No active algos.");
  } else {
    console.log(
      `  ${pad("name", 28)} ${pad("live", 6)} ${pad("broker", 20)} updated`
    );
    for (const a of algos) {
      console.log(
        `  ${pad(a.name as string, 28)} ${pad(a.live_trading_enabled ? "YES" : "no", 6)} ${pad((a.broker_connection_id as string | null)?.slice(0, 18) ?? "—", 20)} ${ageMinutes(a.updated_at as string)}`
      );
    }
  }

  // 2. Open positions
  section("OPEN POSITIONS");
  const { data: open } = await supabase
    .from("paper_positions")
    .select(
      "id, algorithm_id, ticker, side, opened_at, entry_price, broker_fill_price, broker_position_id, current_price, unrealized_pnl, stop_loss_price, take_profit_price"
    )
    .eq("status", "open")
    .order("opened_at");
  if (!open || open.length === 0) {
    console.log("  No open positions.");
  } else {
    for (const p of open) {
      const isPaperOnly = !p.broker_position_id;
      console.log(
        `  ${p.ticker as string} ${(p.side as string).toUpperCase()} @ ${Number(p.entry_price).toFixed(2)} → cur ${Number(p.current_price ?? 0).toFixed(2)} (${ageMinutes(p.opened_at as string)})` +
          `  SL ${Number(p.stop_loss_price ?? 0).toFixed(2)} / TP ${Number(p.take_profit_price ?? 0).toFixed(2)}` +
          `  unrealized $${Number(p.unrealized_pnl ?? 0).toFixed(0)}` +
          (isPaperOnly ? "  ⚠ PAPER-ONLY (no broker_position_id)" : `  broker ${p.broker_position_id}`)
      );
    }
  }

  // 3. Cron heartbeat
  section("CRON HEARTBEAT (last 24h)");
  const { count: manageCount } = await supabase
    .from("activity_log")
    .select("*", { count: "exact", head: true })
    .eq("event_type", "manage_tick")
    .gte("created_at", new Date(Date.now() - 24 * 3600 * 1000).toISOString());
  const { data: lastManage } = await supabase
    .from("activity_log")
    .select("created_at")
    .eq("event_type", "manage_tick")
    .order("created_at", { ascending: false })
    .limit(1);
  const { count: scanCount } = await supabase
    .from("activity_log")
    .select("*", { count: "exact", head: true })
    .eq("event_type", "scan_completed")
    .gte("created_at", new Date(Date.now() - 24 * 3600 * 1000).toISOString());
  const { data: lastScan } = await supabase
    .from("activity_log")
    .select("created_at")
    .eq("event_type", "scan_completed")
    .order("created_at", { ascending: false })
    .limit(1);
  console.log(
    `  manage_tick:    ${manageCount ?? 0} events / 24h, last ${ageMinutes(lastManage?.[0]?.created_at as string | undefined)} (expect 288/24h = every 5min)`
  );
  console.log(
    `  scan_completed: ${scanCount ?? 0} events / 24h, last ${ageMinutes(lastScan?.[0]?.created_at as string | undefined)} (matches manage_tick cadence — scan emits per algo per tick)`
  );
  if (lastManage?.[0]?.created_at) {
    const minSince = Math.floor((Date.now() - new Date(lastManage[0].created_at).getTime()) / 60000);
    if (minSince > 15) {
      console.log(`  ⚠ manage_tick STALE — last event ${minSince}m ago. Cron may be dead.`);
    }
  }

  // 4. Recent event counts
  section("RECENT EVENTS (last 24h, by type)");
  const { data: eventTypes } = await supabase
    .from("activity_log")
    .select("event_type")
    .gte("created_at", new Date(Date.now() - 24 * 3600 * 1000).toISOString());
  const counts = new Map<string, number>();
  for (const e of eventTypes ?? []) {
    counts.set(e.event_type as string, (counts.get(e.event_type as string) ?? 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  for (const [type, n] of sorted) {
    console.log(`  ${pad(type, 30)} ${n}`);
  }

  // 5. Broker sync gaps
  section("BROKER SYNC GAPS (closed positions awaiting broker truth)");
  const { data: unsynced } = await supabase
    .from("paper_positions")
    .select("id, ticker, side, closed_at, realized_pnl, broker_position_id")
    .eq("status", "closed")
    .not("broker_position_id", "is", null)
    .is("broker_realized_synced_at", null)
    .gte("closed_at", new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString())
    .order("closed_at", { ascending: false })
    .limit(10);
  if (!unsynced || unsynced.length === 0) {
    console.log("  None pending. (Run backfill-broker-realized.ts if older rows need sync.)");
  } else {
    for (const p of unsynced) {
      console.log(
        `  ${p.ticker as string} ${(p.side as string)} closed ${ageMinutes(p.closed_at as string)}` +
          `  paper-P&L $${Number(p.realized_pnl ?? 0).toFixed(0)}  broker ${p.broker_position_id}`
      );
    }
  }

  // 6. Last 5 closed trades
  section("LAST 5 CLOSED TRADES");
  const { data: recent } = await supabase
    .from("paper_positions")
    .select(
      "ticker, side, opened_at, closed_at, entry_price, exit_price, realized_pnl, exit_reason, broker_realized_synced_at"
    )
    .eq("status", "closed")
    .order("closed_at", { ascending: false })
    .limit(5);
  if (!recent || recent.length === 0) {
    console.log("  No closed trades.");
  } else {
    for (const p of recent) {
      const synced = (p.broker_realized_synced_at as string | null) ? "broker" : "paper";
      console.log(
        `  ${(p.closed_at as string).slice(0, 16)}  ${p.ticker} ${(p.side as string).padEnd(5)} ` +
          `${Number(p.entry_price).toFixed(2)}→${Number(p.exit_price ?? 0).toFixed(2)} ` +
          `$${Number(p.realized_pnl ?? 0).toFixed(0).padStart(6)} ${pad(p.exit_reason as string, 18)} (${synced})`
      );
    }
  }

  console.log("");
}

main().catch((err) => {
  console.error("live-state.ts failed:", err);
  process.exit(1);
});
