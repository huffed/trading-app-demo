/**
 * SG.9.1 — Live broker health snapshot.
 *
 * Iterates every metaapi `broker_connections` row, calls
 * `fetchAccountInfo` per connection, writes back:
 *   - `last_synced_at` = now() (always, on success OR failure)
 *   - `account_snapshot` = {balance, equity, margin, freeMargin, ...} (success only)
 *   - `last_error` = err.message (failure only; cleared to null on success)
 *
 * Why this exists separately from sync-account-capital.ts:
 *   - sync-account-capital writes `account_capital` (challenge START value, fixed)
 *   - this script writes the HEALTH MONITORING fields the SG.9 /reports
 *     Brokers tab reads from
 *
 * The /reports Brokers tab is a PURE READ from these DB fields. Without this
 * cron, the fields update only when manage/scan cron happens to touch the
 * broker — which doesn't happen when all algos are paused. This cron is the
 * lightweight periodic refresh that keeps the surface honest.
 *
 * Per-connection error handling (intentional):
 *   - Catches the per-connection fetchAccountInfo throw + logs to last_error
 *   - Does NOT abort the batch — one broker down doesn't blank the others
 *   - Script exits 0 (cron success) even with per-connection failures
 *     because the FAILURE STATE was successfully recorded in last_error
 *
 * Script exits non-zero only on catastrophic state (Supabase unreachable,
 * load query failed). Per-connection failures are first-class data.
 *
 * Usage:
 *   pnpm dlx tsx scripts/canonical/snapshot-broker-health.ts
 *   APPLY=0 — dry-run: print verdicts without writing (default = WRITE,
 *             because this is the cron's whole purpose; APPLY=0 is the
 *             ad-hoc inspection mode for the operator)
 */
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import { fetchAccountInfo, type MetaApiRegion } from "@/lib/brokers/metaapi";

// Self-load .env.local — mirrors sibling cron scripts so the wrapper can
// run from cron without manual env exports.
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
    /* no .env.local — let env-vars-missing check below surface it */
  }
}

const APPLY = process.env.APPLY !== "0"; // default WRITE; only APPLY=0 disables
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SUPABASE_SERVICE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_KEY ?? "";

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env.");
  process.exit(1);
}

interface ConnRow {
  id: string;
  label: string;
  provider: string;
  api_token: string;
  account_id: string;
  region: string | null;
}

interface ConnResult {
  conn: ConnRow;
  status: "OK" | "ERROR" | "SKIP_MISSING_CREDS";
  snapshot: { balance: number; equity: number; margin?: number; freeMargin?: number; broker?: string; server?: string; login?: number; type?: string; platform?: string } | null;
  error_message: string | null;
}

async function probeConnection(conn: ConnRow): Promise<ConnResult> {
  if (!conn.api_token || !conn.account_id) {
    return {
      conn,
      status: "SKIP_MISSING_CREDS",
      snapshot: null,
      error_message: "missing api_token or account_id",
    };
  }
  try {
    const info = await fetchAccountInfo(
      conn.api_token,
      conn.account_id,
      (conn.region as MetaApiRegion) ?? "london"
    );
    return {
      conn,
      status: "OK",
      snapshot: {
        balance: info.balance,
        equity: info.equity,
        margin: info.margin,
        freeMargin: info.freeMargin,
        broker: info.broker,
        server: info.server,
        login: info.login,
        type: info.type,
        platform: info.platform,
      },
      error_message: null,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { conn, status: "ERROR", snapshot: null, error_message: msg };
  }
}

/** Per-branch update payload — typed inline so the Supabase generic
 *  client accepts it (a dynamic Record<> doesn't satisfy the schema-
 *  typed `update<T>` signature). */
function buildUpdate(result: ConnResult, syncedAt: string): {
  last_synced_at?: string;
  account_snapshot?: ConnResult["snapshot"];
  last_error?: string | null;
} {
  if (result.status === "OK") {
    return { last_synced_at: syncedAt, account_snapshot: result.snapshot, last_error: null };
  }
  if (result.status === "ERROR") {
    // account_snapshot LEFT ALONE — preserve the last known good snapshot
    // so the operator's Brokers tab still has historical context
    return { last_synced_at: syncedAt, last_error: result.error_message };
  }
  // SKIP_MISSING_CREDS — don't bump last_synced_at because we didn't
  // actually attempt; the broker_connections row is misconfigured and
  // needs operator action (re-enter creds). Surface via last_error.
  return { last_error: result.error_message };
}

async function writeResult(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  result: ConnResult,
  syncedAt: string
): Promise<void> {
  const update = buildUpdate(result, syncedAt);
  const { error } = await supabase
    .from("broker_connections")
    .update(update)
    .eq("id", result.conn.id);
  if (error) {
    throw new Error(
      `broker_connections write failed for ${result.conn.label} (conn_id=${result.conn.id}) — message="${error.message}" code="${error.code ?? "n/a"}" details="${error.details ?? "n/a"}" hint="${error.hint ?? "n/a"}"`
    );
  }
}

function printSummary(results: ConnResult[]): void {
  const ok = results.filter((r) => r.status === "OK").length;
  const err = results.filter((r) => r.status === "ERROR").length;
  const skip = results.filter((r) => r.status === "SKIP_MISSING_CREDS").length;
  console.log(`\nSummary: ${ok} OK, ${err} ERROR, ${skip} SKIP_MISSING_CREDS (total ${results.length})`);

  for (const r of results) {
    const tag = r.status === "OK" ? "OK   " : r.status === "ERROR" ? "ERROR" : "SKIP ";
    if (r.status === "OK" && r.snapshot) {
      console.log(
        `  ${tag} ${r.conn.label}: balance=$${r.snapshot.balance.toFixed(2)} equity=$${r.snapshot.equity.toFixed(2)}`
      );
    } else {
      console.log(`  ${tag} ${r.conn.label}: ${r.error_message ?? "(no detail)"}`);
    }
  }
}

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  console.log(`[snapshot-broker-health] start ${startedAt} mode=${APPLY ? "APPLY" : "DRY"}`);

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: connections, error } = await supabase
    .from("broker_connections")
    .select("id, label, provider, api_token, account_id, region")
    .eq("provider", "metaapi");
  if (error || !connections) {
    throw new Error(
      `load failed: message="${error?.message ?? "no data"}" code="${error?.code ?? "n/a"}" details="${error?.details ?? "n/a"}" hint="${error?.hint ?? "n/a"}"`
    );
  }

  const rows = connections as ConnRow[];
  if (rows.length === 0) {
    console.log("No metaapi connections — nothing to snapshot.");
    return;
  }

  // Probe each connection sequentially. Parallel would be faster but
  // MetaApi rate-limits aggressively and this is a 6h cron, not latency-
  // critical; sequential keeps per-connection errors isolated + easier to
  // read in cron logs.
  const results: ConnResult[] = [];
  for (const conn of rows) {
    results.push(await probeConnection(conn));
  }

  printSummary(results);

  if (!APPLY) {
    console.log("\nDRY RUN (APPLY=0) — not writing.");
    return;
  }

  console.log("\nWriting snapshot results to broker_connections...");
  const syncedAt = new Date().toISOString();
  for (const r of results) {
    await writeResult(supabase, r, syncedAt);
  }
  console.log("Done.");
}

void main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
