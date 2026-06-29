/**
 * Enable broker mirroring on the 3-algo gold portfolio (2026-06-29 NIGHT+3).
 *
 * Operator asked "mirror those on the broker demo". The deployed algos
 * are currently paper-only (live_trading_enabled=false). Switching to
 * broker-mirror means:
 *   - Set broker_connection_id to active broker (FTMO Test $100k)
 *   - Update capital to match broker account ($10K → $100K)
 *   - Set live_trading_enabled = true
 *
 * Pre-checks performed inside this script:
 *   1. Verify exactly 1 active broker_connection exists
 *   2. Verify FTMO-compliant prop_firm rules on each algo (max_dd=10,
 *      daily_loss_limit=5, combined_risk_cap_pct=4 — all sibling algos
 *      sharing the broker pool will halt-coordinate via portfolio-halt.ts
 *      + risk-pool-halt.ts under these caps)
 *   3. WARN if cron silent in last 24h (broker mirroring won't fire
 *      until operator's Mac cron resumes)
 *   4. WARN if broker_connection.last_synced_at > 24h ago (MetaApi token
 *      may have expired; operator must re-auth via /settings/brokers UI)
 *
 * Reversible: SET live_trading_enabled=false + capital back to 10000.
 * Or fully archive deployed algos.
 *
 * Idempotent: if mirror already enabled with correct config, no-op.
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

const NEW_CAPITAL = 100000; // match FTMO Test $100k

async function main(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const sb = createClient<Database>(url, key);

  console.log("Enable broker mirroring on 3-algo gold portfolio");
  console.log("");

  // 1. Find active broker connections
  const { data: brokers, error: brokErr } = await sb.from("broker_connections")
    .select("id, label, provider, broker_name, account_login, status, account_capital, last_synced_at")
    .eq("status", "active");
  if (brokErr || !brokers) throw new Error(`fetch brokers: ${brokErr?.message}`);
  if (brokers.length === 0) {
    console.error("FATAL: no active broker_connections found. Operator must add one via /settings/brokers.");
    process.exit(1);
  }
  if (brokers.length > 1) {
    console.error(`FATAL: ${brokers.length} active broker_connections found. Cannot auto-pick. Specify via env BROKER_CONNECTION_ID.`);
    for (const b of brokers) console.error(`  ${b.id} | ${b.label} | ${b.broker_name} | $${b.account_capital}`);
    process.exit(1);
  }
  const broker = brokers[0];
  console.log(`Active broker connection: ${broker.label} (${broker.provider}, ${broker.broker_name})`);
  console.log(`  id           : ${broker.id}`);
  console.log(`  account      : ${broker.account_login}`);
  console.log(`  capital      : $${broker.account_capital}`);
  console.log(`  last synced  : ${broker.last_synced_at}`);
  const syncAgeMs = Date.now() - Date.parse(broker.last_synced_at ?? "");
  const syncAgeDays = syncAgeMs / (24 * 3600 * 1000);
  if (syncAgeDays > 1) {
    console.log(`  ⚠ WARN: broker connection last synced ${syncAgeDays.toFixed(1)}d ago. MetaApi token may have expired.`);
    console.log(`    OPERATOR ACTION: re-authenticate via /settings/brokers BEFORE relying on order placement.`);
  }
  console.log("");

  // 2. Find target algos
  const { data: algos, error: algoErr } = await sb.from("algorithms")
    .select("id, name, capital, broker_connection_id, live_trading_enabled, rules")
    .like("name", "Deploy: %");
  if (algoErr || !algos) throw new Error(`fetch algos: ${algoErr?.message}`);
  if (algos.length === 0) {
    console.error("FATAL: no Deploy:* algos found.");
    process.exit(1);
  }
  console.log(`Found ${algos.length} Deploy:* algos`);
  console.log("");

  // 3. Verify FTMO-compliant prop_firm rules
  for (const a of algos) {
    const pf = (a.rules as Record<string, unknown> | null)?.prop_firm as Record<string, unknown> | undefined;
    if (!pf) {
      console.error(`FATAL: ${a.name} has no prop_firm rules. Aborting.`);
      process.exit(1);
    }
    const maxDd = Number(pf.max_drawdown ?? 0);
    const dailyLimit = Number(pf.daily_loss_limit ?? 0);
    const combinedCap = Number(pf.combined_risk_cap_pct ?? 0);
    if (maxDd > 10) {
      console.error(`FATAL: ${a.name} prop_firm.max_drawdown=${maxDd}% > FTMO 10%. Aborting.`);
      process.exit(1);
    }
    if (dailyLimit > 5) {
      console.error(`FATAL: ${a.name} prop_firm.daily_loss_limit=${dailyLimit}% > FTMO 5%. Aborting.`);
      process.exit(1);
    }
    if (combinedCap > 5) {
      console.log(`  ⚠ NOTE: ${a.name} prop_firm.combined_risk_cap_pct=${combinedCap}% — siblings can accumulate to this. OK if all algos share FTMO 5% daily loss limit.`);
    }
  }
  console.log(`✓ All algos have FTMO-compliant prop_firm rules (max_dd≤10, daily≤5)`);
  console.log("");

  // 4. Check cron staleness
  const { data: cronEvents } = await sb.from("activity_log")
    .select("event_type, created_at")
    .in("event_type", ["scan_started", "scan_completed", "manage_tick", "cron_idle"])
    .order("created_at", { ascending: false })
    .limit(1);
  if (cronEvents && cronEvents.length > 0) {
    const lastCron = cronEvents[0];
    const cronAgeMs = Date.now() - Date.parse(lastCron.created_at ?? "");
    const cronAgeHours = cronAgeMs / (3600 * 1000);
    if (cronAgeHours > 2) {
      console.log(`⚠ WARN: cron last fired ${cronAgeHours.toFixed(1)}h ago (${lastCron.event_type}).`);
      console.log(`    OPERATOR ACTION: start crontab on Mac. See scripts/README.md for cron entries.`);
      console.log(`    Without cron, broker mirroring will NOT fire even though configured.`);
    } else {
      console.log(`✓ Cron last fired ${cronAgeHours.toFixed(1)}h ago — alive.`);
    }
  } else {
    console.log(`⚠ WARN: no cron events found in activity_log. Cron likely never started.`);
  }
  console.log("");

  // 5. Update each algo
  console.log("Updating algos:");
  let updated = 0, alreadyConfigured = 0;
  for (const a of algos) {
    const needsCapitalUpdate = Number(a.capital) !== NEW_CAPITAL;
    const needsBrokerUpdate = a.broker_connection_id !== broker.id;
    const needsLiveUpdate = a.live_trading_enabled !== true;
    if (!needsCapitalUpdate && !needsBrokerUpdate && !needsLiveUpdate) {
      console.log(`  - ${a.name}: already mirrored to ${broker.label}, skip`);
      alreadyConfigured++;
      continue;
    }
    const { error: updErr } = await sb.from("algorithms").update({
      capital: NEW_CAPITAL,
      broker_connection_id: broker.id,
      live_trading_enabled: true,
    }).eq("id", a.id);
    if (updErr) {
      console.error(`  ✗ ${a.name}: UPDATE failed: ${updErr.message}`);
      continue;
    }
    console.log(`  ✓ ${a.name}: capital $${a.capital}→$${NEW_CAPITAL}, broker→${broker.label}, live_trading=true`);
    updated++;
  }
  console.log("");
  console.log(`Result: ${updated} updated, ${alreadyConfigured} already configured`);
  console.log("");
  console.log("Reverse if needed:");
  console.log(`  UPDATE algorithms SET live_trading_enabled=false, broker_connection_id=NULL, capital=10000 WHERE name LIKE 'Deploy: %';`);
  console.log("");
  console.log("Final portfolio state:");
  const { data: finalState } = await sb.from("algorithms")
    .select("id, name, capital, broker_connection_id, live_trading_enabled, rules")
    .like("name", "Deploy: %");
  for (const a of finalState ?? []) {
    const rules = a.rules as { position_sizing?: { value?: number } } | null;
    const risk = rules?.position_sizing?.value ?? "?";
    const live = a.live_trading_enabled ? "LIVE" : "PAPER";
    const brokerMark = a.broker_connection_id ? "→broker" : "INTERNAL";
    console.log(`  [${live}|${brokerMark}] ${a.name} | capital=$${a.capital} risk=${risk}%`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
