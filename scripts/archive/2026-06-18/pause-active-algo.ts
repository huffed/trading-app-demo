/**
 * Pause the active "Forex testing" algo (or any algorithm by ID). Two
 * modes:
 *
 *   ACTION=pause   (default): set status=paused + live_trading_enabled=false.
 *                  Existing open positions stay open and the manage cron
 *                  continues to mirror SL/TP/stagnant exits on them. New
 *                  scans skip the algo (status=paused short-circuits).
 *
 *   ACTION=flatten: pause AS ABOVE plus call POST /api/admin/flatten-algo
 *                  to close every open broker position immediately.
 *                  Realises whatever P&L is currently mark-to-market.
 *
 * Run: pnpm tsx scripts/pause-active-algo.ts
 *
 * Env:
 *   ALGO_ID  (default: 0fda73df-6728-4b69-aa98-f8a29c483466 — the active algo)
 *   ACTION   (pause | flatten; default pause)
 *   API_BASE (default http://localhost:3000)
 *   CRON_SECRET / NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local
 *
 * Pre-requisite for ACTION=flatten: dev server running on API_BASE.
 */
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";

// Manual env loader.
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

const DEFAULT_ALGO_ID = "0fda73df-6728-4b69-aa98-f8a29c483466";

async function pauseAlgo(algoId: string): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env.local"
    );
  }
  const supabase = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: before, error: readErr } = await supabase
    .from("algorithms")
    .select("id, name, status, live_trading_enabled")
    .eq("id", algoId)
    .single();
  if (readErr || !before) {
    throw new Error(`Could not read algorithm ${algoId}: ${readErr?.message ?? "not found"}`);
  }

  const beforeRow = before as {
    id: string;
    name: string;
    status: string;
    live_trading_enabled: boolean | null;
  };
  console.log("Before:");
  console.log(`  id      : ${beforeRow.id}`);
  console.log(`  name    : ${beforeRow.name}`);
  console.log(`  status  : ${beforeRow.status}`);
  console.log(`  live    : ${beforeRow.live_trading_enabled ?? false}`);

  const { error: updateErr } = await supabase
    .from("algorithms")
    .update({ status: "paused", live_trading_enabled: false })
    .eq("id", algoId);
  if (updateErr) {
    throw new Error(`Pause update failed: ${updateErr.message}`);
  }

  console.log("\nAfter:");
  console.log(`  status  : paused`);
  console.log(`  live    : false`);
  console.log(
    "\nNew scans will skip this algorithm. Existing open positions remain — manage cron continues SL/TP/stagnant exit checks."
  );
}

async function flattenAlgo(algoId: string): Promise<void> {
  const apiBase = process.env.API_BASE ?? "http://localhost:3000";
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    throw new Error("CRON_SECRET must be set in .env.local for ACTION=flatten");
  }

  const endpoint = `${apiBase}/api/admin/flatten-algo?id=${encodeURIComponent(algoId)}`;
  console.log(`\nCalling ${endpoint} ...`);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${cronSecret}` },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Flatten failed: ${response.status} ${text}`);
  }
  const body = (await response.json()) as { flattened: number; results: unknown[] };
  console.log(`\nFlattened ${body.flattened} position(s).`);
  for (const r of body.results) {
    console.log(`  ${JSON.stringify(r)}`);
  }
}

async function main(): Promise<void> {
  const algoId = process.env.ALGO_ID ?? DEFAULT_ALGO_ID;
  const action = (process.env.ACTION ?? "pause").toLowerCase();

  console.log(`Pause active algo runner`);
  console.log(`  algo_id : ${algoId}`);
  console.log(`  action  : ${action}\n`);

  if (action !== "pause" && action !== "flatten") {
    throw new Error(`ACTION must be "pause" or "flatten", got "${action}"`);
  }

  await pauseAlgo(algoId);
  if (action === "flatten") {
    await flattenAlgo(algoId);
  }

  console.log("\nDone.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
