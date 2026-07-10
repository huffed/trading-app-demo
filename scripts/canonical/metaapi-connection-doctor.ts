/**
 * MetaApi connection doctor — one-command diagnosis of "why is the broker
 * connection red?". Born from the 2026-07-11 incident: the frontend showed
 * the generic "Network error reaching MetaApi" while the real state was
 * account DEPLOYED but DISCONNECTED (FTMO demo credentials expired — the
 * MT5 login stopped authenticating at the broker).
 *
 * What it checks, in order:
 *   1. broker_connections row (region/account_id/status/last_error)
 *   2. MetaApi PROVISIONING state (region-independent) — state,
 *      connectionStatus, region, login, server
 *   3. Region sanity: provisioning region vs row region (auto-fixes row on
 *      mismatch with APPLY=1)
 *   4. Optional REDEPLOY=1 — restarts the cloud terminal + polls
 *      connectionStatus for POLL_SECONDS (default 240)
 *   5. On CONNECTED: verifies client-api /account-information and (APPLY=1)
 *      marks the row healthy (status=active, last_error=null, synced now)
 *
 * Verdict map:
 *   UNDEPLOYED            → deploy the account in the MetaApi dashboard
 *                           (requires MetaApi credit/billing)
 *   DEPLOYED+DISCONNECTED → the cloud terminal can't log into the broker:
 *                           credentials expired/wrong or broker server
 *                           down. For FTMO demos: create a fresh demo in
 *                           the FTMO client area, then update LOGIN +
 *                           PASSWORD + SERVER on the SAME MetaApi account
 *                           (MetaApi dashboard → account → credentials) —
 *                           account id stays, no app-side change needed.
 *   provisioning 404      → account deleted at MetaApi: create a new
 *                           MetaApi account, then update
 *                           broker_connections.account_id
 *   DEPLOYED+CONNECTED    → healthy; row marked active (APPLY=1)
 *
 * Usage:
 *   pnpm dlx tsx scripts/canonical/metaapi-connection-doctor.ts                 # diagnose default (FTMO Test $100k)
 *   CONN_ID=<uuid> pnpm dlx tsx scripts/canonical/metaapi-connection-doctor.ts
 *   REDEPLOY=1 APPLY=1 pnpm dlx tsx scripts/canonical/metaapi-connection-doctor.ts
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

const CONN_ID = process.env.CONN_ID ?? "c508808c-e799-444e-a34e-47c36af23bc4";
const PROVISIONING = "https://mt-provisioning-api-v1.agiliumtrade.agiliumtrade.ai";
const APPLY = process.env.APPLY === "1";
const REDEPLOY = process.env.REDEPLOY === "1";
const POLL_SECONDS = Number(process.env.POLL_SECONDS ?? "240");

interface ProvisioningAccount {
  name?: string;
  state?: string;
  connectionStatus?: string;
  region?: string;
  login?: string;
  server?: string;
  type?: string;
  createdAt?: string;
}

async function provisioningGet(token: string, accountId: string): Promise<{ status: number; account: ProvisioningAccount | null; body: string }> {
  const res = await fetch(`${PROVISIONING}/users/current/accounts/${accountId}`, {
    headers: { "auth-token": token },
    signal: AbortSignal.timeout(20_000),
  });
  const body = await res.text();
  return { status: res.status, account: res.ok ? (JSON.parse(body) as ProvisioningAccount) : null, body };
}

async function main(): Promise<void> {
  const sb = createClient<Database>(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const { data: conn } = await sb
    .from("broker_connections")
    .select("id, label, account_id, api_token, region, status, last_error")
    .eq("id", CONN_ID)
    .maybeSingle();
  if (!conn) throw new Error(`broker_connections row ${CONN_ID} not found`);
  console.log(`Row: ${conn.label} — account ${conn.account_id}, region=${conn.region}, status=${conn.status}`);

  const first = await provisioningGet(conn.api_token, conn.account_id);
  if (first.status === 401) {
    console.log("VERDICT: MetaApi token rejected (401) — re-enter the token in Settings → Brokers.");
    return;
  }
  if (first.status === 404) {
    console.log("VERDICT: account DELETED at MetaApi (provisioning 404) — create a new MetaApi account, then update broker_connections.account_id.");
    return;
  }
  if (!first.account) {
    console.log(`VERDICT: provisioning API unreachable/unexpected (HTTP ${first.status}): ${first.body.slice(0, 160)}`);
    return;
  }
  let a = first.account;
  console.log(`MetaApi: state=${a.state} connection=${a.connectionStatus} region=${a.region} login=${a.login} server=${a.server} type=${a.type} created=${a.createdAt}`);

  if (a.region && a.region !== conn.region) {
    console.log(`Region mismatch: row=${conn.region} vs MetaApi=${a.region}${APPLY ? " — fixing row" : " (APPLY=1 to fix row)"}`);
    if (APPLY) await sb.from("broker_connections").update({ region: a.region }).eq("id", conn.id);
  }

  if (a.state !== "DEPLOYED") {
    console.log(`VERDICT: account state=${a.state} — deploy it in the MetaApi dashboard (needs MetaApi credit).`);
    return;
  }

  if (a.connectionStatus !== "CONNECTED" && REDEPLOY) {
    const rd = await fetch(`${PROVISIONING}/users/current/accounts/${conn.account_id}/redeploy`, {
      method: "POST",
      headers: { "auth-token": conn.api_token },
    });
    console.log(`Redeploy → HTTP ${rd.status}; polling up to ${POLL_SECONDS}s…`);
    const rounds = Math.max(1, Math.floor(POLL_SECONDS / 20));
    for (let i = 0; i < rounds; i++) {
      await new Promise((r) => setTimeout(r, 20_000));
      const p = await provisioningGet(conn.api_token, conn.account_id);
      a = p.account ?? a;
      console.log(`  +${(i + 1) * 20}s: state=${a.state} connection=${a.connectionStatus}`);
      if (a.connectionStatus === "CONNECTED") break;
    }
  }

  if (a.connectionStatus === "CONNECTED") {
    const region = a.region ?? conn.region ?? "london";
    const info = await fetch(
      `https://mt-client-api-v1.${region}.agiliumtrade.ai/users/current/accounts/${conn.account_id}/account-information`,
      { headers: { "auth-token": conn.api_token }, signal: AbortSignal.timeout(25_000) }
    );
    console.log(`client-api account-information → HTTP ${info.status}`);
    if (info.status === 200 && APPLY) {
      await sb
        .from("broker_connections")
        .update({ status: "active", last_error: null, last_synced_at: new Date().toISOString() })
        .eq("id", conn.id);
      console.log("Row marked healthy (status=active). Frontend sync will show green.");
    }
    console.log("VERDICT: HEALTHY — terminal connected to broker.");
    return;
  }

  console.log(
    "VERDICT: DEPLOYED but DISCONNECTED — the cloud terminal cannot log into the broker.\n" +
      `  Most likely: the ${a.server ?? "broker"} credentials for login ${a.login ?? "?"} expired ` +
      "(FTMO demo/trial accounts expire).\n" +
      "  Fix: create a fresh FTMO demo in the FTMO client area → MetaApi dashboard → this account →\n" +
      "  update LOGIN + PASSWORD + SERVER (account id stays; no app-side change) → re-run this doctor\n" +
      "  with REDEPLOY=1 APPLY=1 to confirm CONNECTED + mark the row healthy."
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
