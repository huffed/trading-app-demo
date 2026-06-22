/**
 * Stage 0.2 — Sync `broker_connections.account_capital` from MetaApi.
 *
 * Why: account_capital values were set by hand from labels (Stage 0.2 entry
 * in project_roadmap_2026_06.md). Operator stance 2026-06-19 is "assume
 * nothing valid" — replace label-guesses with API truth before any Phase B
 * re-validation runs.
 *
 * Hardened protocol (per roadmap Stage 0.2):
 *   (a) snapshot existing account_capital values
 *   (b) fetch fresh balance/equity via fetchAccountInfo() per connection
 *   (c) print diff per connection (SYNCED / SKIPPED / KEPT)
 *   (d) per-connection error → SKIP (keep existing value), don't abort the batch
 *   (e) per-connection success but balance ≤ 0 → SKIP (don't overwrite with invalid)
 *   (f) only WRITE if APPLY=1; never write to skipped connections
 *
 * Usage:
 *   pnpm dlx tsx scripts/canonical/sync-account-capital.ts          # DRY RUN (default)
 *   APPLY=1 pnpm dlx tsx scripts/canonical/sync-account-capital.ts  # write to DB
 */
import { createClient } from "@supabase/supabase-js";
import { fetchAccountInfo, type MetaApiRegion } from "@/lib/brokers/metaapi";

const APPLY = process.env.APPLY === "1";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SUPABASE_SERVICE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_KEY ?? "";

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env.");
  process.exit(1);
}

type ConnRow = {
  id: string;
  label: string;
  provider: string;
  api_token: string;
  account_id: string;
  region: string | null;
  account_capital: number | string | null;
};

async function main(): Promise<void> {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: connections, error } = await supabase
    .from("broker_connections")
    .select("id, label, provider, api_token, account_id, region, account_capital")
    .eq("provider", "metaapi");

  if (error || !connections) {
    // B.2.40 sweep (2026-06-19 EVE): preserve full Supabase error context
    // (.code/.details/.hint) — bare `error?.message` lost actionable
    // metadata like "permission denied for table broker_connections" hints.
    throw new Error(
      `Failed to load broker_connections: message="${error?.message ?? "no data returned"}" code="${error?.code ?? "n/a"}" details="${error?.details ?? "n/a"}" hint="${error?.hint ?? "n/a"}"`
    );
  }

  const rows = connections as ConnRow[];
  console.log(
    `Syncing account_capital for ${rows.length} metaapi connection(s) — mode: ${
      APPLY ? "APPLY (will write)" : "DRY RUN (no writes)"
    }\n`
  );

  const results: Array<{
    conn: ConnRow;
    info: { balance: number; equity: number } | null;
    error: string | null;
  }> = [];

  for (const conn of rows) {
    if (!conn.api_token || !conn.account_id) {
      results.push({
        conn,
        info: null,
        error: `missing api_token or account_id`,
      });
      continue;
    }
    try {
      const info = await fetchAccountInfo(
        conn.api_token,
        conn.account_id,
        (conn.region as MetaApiRegion) ?? "london"
      );
      results.push({
        conn,
        info: { balance: info.balance, equity: info.equity },
        error: null,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      results.push({ conn, info: null, error: msg });
    }
  }

  // Categorise per-connection results
  type Verdict = "SYNC" | "SKIP_ERROR" | "SKIP_INVALID_BALANCE";
  const verdicts = results.map((r) => {
    if (r.error) return { ...r, verdict: "SKIP_ERROR" as Verdict };
    if (!r.info || !Number.isFinite(r.info.balance) || r.info.balance <= 0) {
      return { ...r, verdict: "SKIP_INVALID_BALANCE" as Verdict };
    }
    return { ...r, verdict: "SYNC" as Verdict };
  });

  // Print verdict table
  console.log("┌─────────────────────────────────┬───────────┬───────────┬───────────┬────────────┬─────────────────────┐");
  console.log("│ Connection                      │ Old       │ Balance   │ Equity    │ Diff       │ Verdict             │");
  console.log("├─────────────────────────────────┼───────────┼───────────┼───────────┼────────────┼─────────────────────┤");
  for (const r of verdicts) {
    const oldCap = Number(r.conn.account_capital ?? 0);
    const label = r.conn.label.padEnd(31).slice(0, 31);
    const oldStr = oldCap.toFixed(2).padStart(9);
    if (r.verdict === "SYNC" && r.info) {
      const newBal = r.info.balance;
      const diff = newBal - oldCap;
      const balStr = newBal.toFixed(2).padStart(9);
      const eqStr = r.info.equity.toFixed(2).padStart(9);
      const diffStr =
        diff === 0
          ? "—".padStart(10)
          : (diff > 0 ? `+${diff.toFixed(2)}` : diff.toFixed(2)).padStart(10);
      console.log(`│ ${label} │ ${oldStr} │ ${balStr} │ ${eqStr} │ ${diffStr} │ SYNC                │`);
    } else {
      const verdictLabel = (r.verdict === "SKIP_ERROR" ? "SKIP (api error)" : "SKIP (invalid bal)").padEnd(19);
      console.log(`│ ${label} │ ${oldStr} │       n/a │       n/a │        n/a │ ${verdictLabel} │`);
    }
  }
  console.log("└─────────────────────────────────┴───────────┴───────────┴───────────┴────────────┴─────────────────────┘");

  // Print error detail
  const skipErrors = verdicts.filter((v) => v.verdict === "SKIP_ERROR");
  if (skipErrors.length > 0) {
    console.log("\nSkipped (API error — existing value preserved):");
    for (const r of skipErrors) {
      console.log(`  ${r.conn.label}: ${r.error}`);
    }
  }

  const syncCount = verdicts.filter((v) => v.verdict === "SYNC").length;
  const skipCount = verdicts.length - syncCount;
  console.log(`\nSummary: ${syncCount} to SYNC, ${skipCount} to SKIP.`);

  if (!APPLY) {
    console.log("\nDRY RUN. Set APPLY=1 to write the SYNC rows:");
    console.log("  APPLY=1 pnpm dlx tsx scripts/canonical/sync-account-capital.ts");
    return;
  }

  if (syncCount === 0) {
    console.log("\nNothing to write — 0 SYNC verdicts.");
    return;
  }

  console.log("\nAPPLY=1 — writing SYNC rows to DB...");
  for (const r of verdicts) {
    if (r.verdict !== "SYNC" || !r.info) continue;
    const { error: updateError } = await supabase
      .from("broker_connections")
      .update({ account_capital: r.info.balance })
      .eq("id", r.conn.id);
    if (updateError) {
      // B.2.40 sweep: preserve Supabase error metadata + label which row
      // failed so partial-batch writes are auditable (some SYNCs may have
      // succeeded before this one failed; we throw to bubble up to the
      // top-level main().catch handler which logs + exits 1 cleanly).
      throw new Error(
        `sync-account-capital: write failed for ${r.conn.label} (conn_id=${r.conn.id}) — message="${updateError.message}" code="${updateError.code ?? "n/a"}" details="${updateError.details ?? "n/a"}" hint="${updateError.hint ?? "n/a"}"`
      );
    }
    console.log(`  OK ${r.conn.label}: ${r.info.balance.toFixed(2)}`);
  }
  console.log("\nDone.");
}

void main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
