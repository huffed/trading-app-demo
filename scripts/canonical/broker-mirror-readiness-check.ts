/**
 * Readiness check: are all preconditions for broker mirroring satisfied?
 *
 * Run this BEFORE expecting orders to flow:
 *   pnpm dlx tsx scripts/canonical/broker-mirror-readiness-check.ts
 *
 * Checks:
 *   1. Active broker_connection exists + last_synced recent
 *   2. 3-algo portfolio configured: live_trading_enabled=true,
 *      broker_connection_id set, capital matches broker
 *   3. Cron alive: scan + manage fired in last 30 min
 *   4. price_cache fresh for XAU/USD 4h
 *   5. FTMO halts NOT already triggered (no kill_switch / daily halt)
 *   6. No open positions from prior runs (clean slate)
 *
 * Exits 0 if green; 1 if any check fails (with detail).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "../../src/lib/supabase/database.types";

function loadEnvLocal(): void {
  try {
    const envText = readFileSync(resolve(process.cwd(), ".env.local"), "utf-8");
    for (const line of envText.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      if (!(key in process.env)) process.env[key] = val;
    }
  } catch {}
}
loadEnvLocal();

async function main(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const sb = createClient<Database>(url, key);

  let fails = 0;
  const fail = (msg: string) => { console.log(`  ✗ ${msg}`); fails++; };
  const pass = (msg: string) => console.log(`  ✓ ${msg}`);
  const warn = (msg: string) => console.log(`  ⚠ ${msg}`);

  console.log("Broker-mirror readiness check");
  console.log("=".repeat(60));

  // 1. Broker connection
  console.log("\n1. BROKER CONNECTION");
  const { data: brokers } = await sb.from("broker_connections")
    .select("id, label, status, last_synced_at, account_capital");
  const active = (brokers ?? []).filter((b) => b.status === "active");
  if (active.length === 0) fail(`No active broker_connections (have ${brokers?.length ?? 0} total, none active)`);
  else if (active.length > 1) warn(`${active.length} active brokers — algos may be split across them`);
  else {
    const b = active[0];
    pass(`Active broker: ${b.label} ($${b.account_capital})`);
    const ageHr = (Date.now() - Date.parse(b.last_synced_at ?? "")) / (3600 * 1000);
    if (ageHr > 24) fail(`Broker last synced ${ageHr.toFixed(1)}h ago — token likely expired. Re-auth at /settings/brokers.`);
    else pass(`Broker synced ${ageHr.toFixed(1)}h ago`);
  }

  // 2. Algo config
  console.log("\n2. ALGO CONFIG (Deploy:*)");
  const { data: algos } = await sb.from("algorithms")
    .select("id, name, capital, broker_connection_id, live_trading_enabled, status, rules")
    .like("name", "Deploy: %");
  if (!algos || algos.length === 0) fail("No Deploy:* algos found");
  else {
    for (const a of algos) {
      const issues: string[] = [];
      if (a.status !== "active") issues.push(`status=${a.status} (need active)`);
      if (!a.live_trading_enabled) issues.push("live_trading_enabled=false");
      if (!a.broker_connection_id) issues.push("no broker_connection_id");
      const broker = active.find((b) => b.id === a.broker_connection_id);
      if (broker && Number(a.capital) !== Number(broker.account_capital)) {
        issues.push(`capital $${a.capital} ≠ broker $${broker.account_capital}`);
      }
      if (issues.length === 0) pass(`${a.name}: ready`);
      else fail(`${a.name}: ${issues.join(", ")}`);
    }
  }

  // 3. Cron alive
  console.log("\n3. CRON ALIVE");
  const { data: scan } = await sb.from("activity_log")
    .select("created_at").in("event_type", ["scan_started", "scan_completed", "cron_idle"])
    .order("created_at", { ascending: false }).limit(1);
  const { data: manage } = await sb.from("activity_log")
    .select("created_at").in("event_type", ["manage_tick", "cron_idle"])
    .order("created_at", { ascending: false }).limit(1);
  if (!scan || scan.length === 0) fail("No scan events ever recorded");
  else {
    const age = (Date.now() - Date.parse(scan[0].created_at ?? "")) / 60_000;
    if (age > 35) fail(`Scan cron last fired ${age.toFixed(1)} min ago (>35min stale)`);
    else pass(`Scan cron fired ${age.toFixed(1)} min ago`);
  }
  if (!manage || manage.length === 0) fail("No manage events ever recorded");
  else {
    const age = (Date.now() - Date.parse(manage[0].created_at ?? "")) / 60_000;
    if (age > 15) fail(`Manage cron last fired ${age.toFixed(1)} min ago (>15min stale)`);
    else pass(`Manage cron fired ${age.toFixed(1)} min ago`);
  }

  // 4. price_cache freshness (column is `fetched_at` not `updated_at`; interval label is `4h` not `4hour`)
  console.log("\n4. PRICE CACHE (XAU/USD 4h)");
  const { data: cache } = await sb.from("price_cache")
    .select("fetched_at, bar_count").eq("ticker", "XAU/USD").eq("interval", "4h").eq("output_size", "full").limit(1).maybeSingle();
  if (!cache) fail("No XAU/USD 4h cache row");
  else {
    const ageHr = (Date.now() - Date.parse(cache.fetched_at ?? "")) / (3600 * 1000);
    if (ageHr > 48) warn(`price_cache last fetched ${ageHr.toFixed(1)}h ago — cron will refresh when alive (next scan tick)`);
    else pass(`price_cache fresh (${ageHr.toFixed(1)}h, ${cache.bar_count} bars)`);
  }

  // 5. FTMO halts not triggered
  console.log("\n5. NO ACTIVE HALTS");
  const { data: halts } = await sb.from("activity_log")
    .select("event_type, created_at, details")
    .in("event_type", ["daily_halt_triggered", "consec_loss_halt_triggered", "portfolio_halt_triggered", "consistency_halt_triggered", "risk_pool_halt_triggered"])
    .gte("created_at", new Date(Date.now() - 24 * 3600 * 1000).toISOString())
    .order("created_at", { ascending: false });
  if (!halts || halts.length === 0) pass("No halts in last 24h");
  else {
    for (const h of halts.slice(0, 5)) fail(`Halt active: ${h.event_type} at ${h.created_at}`);
  }

  // 6. Open positions check
  console.log("\n6. OPEN POSITIONS");
  const { data: open } = await sb.from("paper_positions").select("id, algorithm_id, ticker, side").eq("status", "open");
  if (!open || open.length === 0) pass("No open positions (clean slate)");
  else warn(`${open.length} open position(s) — they continue under existing rules`);

  console.log("\n" + "=".repeat(60));
  if (fails === 0) console.log("✓ READY — broker mirroring should fire on next cron tick + new entry signal");
  else console.log(`✗ NOT READY — ${fails} check(s) failed. Fix above before expecting orders.`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
