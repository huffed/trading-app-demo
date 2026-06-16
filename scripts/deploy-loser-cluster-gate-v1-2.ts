/**
 * Deploy the V1.2 loser-cluster block_joint gate (shadow mode) on the
 * 4 gateless algos surfaced by V1.2 (PR #239) as trading INTO the
 * Bonferroni-significant `discount ∩ london(7-13) ∩ compressed`
 * cluster (n=74, R=-0.76, pBonf=0.000).
 *
 * Target gate clause added to each algo's `rules.market_state_gate`:
 *
 *   {
 *     "mode": "block_joint",
 *     "states": {
 *       "entry_zone": ["discount"],
 *       "entry_hour_bucket": ["london(7-13)"],
 *       "range": ["compressed"]
 *     },
 *     "on_unreadable": "allow",
 *     "shadow": true
 *   }
 *
 * Schema requires PR #237 (merged 2026-06-16). The 3 gated algos
 * (bear_short_4h, breakdown_rider_4h, dip_buyer_4h) have existing
 * single market_state_gates and are NOT touched by this script — they
 * need the gate-composition follow-up first.
 *
 * Safety:
 *   - DRY RUN by default. Pass APPLY=1 to actually update.
 *   - Identifies targets via ALGO_IDS or ALGO_NAMES env (operator
 *     supplies; the V1 spec keys like "coil_breakout_1h" don't map
 *     1:1 to live algo names).
 *   - Refuses to overwrite an EXISTING market_state_gate. If an algo
 *     already has one, the script skips it and logs a warning.
 *   - Prints before/after of `rules.market_state_gate` for every
 *     target, regardless of dry run or apply.
 *
 * Usage:
 *   # discover live algos:
 *   pnpm dlx tsx scripts/live-state.ts
 *
 *   # dry run on a single algo by UUID:
 *   ALGO_IDS=abc123-... pnpm dlx tsx scripts/deploy-loser-cluster-gate-v1-2.ts
 *
 *   # dry run on multiple by name:
 *   ALGO_NAMES="FVG Long 30m,Mean Reversion Long 4h" pnpm dlx tsx scripts/deploy-loser-cluster-gate-v1-2.ts
 *
 *   # apply:
 *   APPLY=1 ALGO_IDS=abc123,def456 pnpm dlx tsx scripts/deploy-loser-cluster-gate-v1-2.ts
 *
 * Env required in .env.local:
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * After running with APPLY=1, tail activity_log for
 * `signal_no_action` events with `details.reason="market_state_gate_shadow"`.
 * Once ~10-20 shadow blocks accumulate, compare to the V1.2 signature
 * (n=74, R=-0.76) before flipping `shadow: false`.
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

const APPLY = process.env.APPLY === "1";
const ALGO_IDS = (process.env.ALGO_IDS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const ALGO_NAMES = (process.env.ALGO_NAMES ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const TARGET_GATE = {
  mode: "block_joint" as const,
  states: {
    entry_zone: ["discount"] as const,
    entry_hour_bucket: ["london(7-13)"] as const,
    range: ["compressed"] as const,
  },
  on_unreadable: "allow" as const,
  shadow: true as const,
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Postgres JSONB reorders object keys on storage, so equality must
// canonicalize before comparing. Array order is preserved (positional).
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) sorted[k] = canonicalize(obj[k]);
    return sorted;
  }
  return value;
}

// `supabase` is typed loosely here because the SupabaseClient generic
// parameters inferred at the call site don't match the bare
// ReturnType<typeof createClient>. This is a script file — any is fine.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function resolveAlgoIds(
  supabase: any,
  ids: string[]
): Promise<string[]> {
  const full = ids.filter((id) => UUID_RE.test(id));
  const prefixes = ids.filter((id) => !UUID_RE.test(id));
  if (prefixes.length === 0) return full;

  for (const p of prefixes) {
    if (!/^[0-9a-f-]{1,35}$/i.test(p)) {
      throw new Error(
        `ALGO_IDS contains invalid value: "${p}" — must be a full UUID or hex prefix.`
      );
    }
  }

  const { data: all, error } = await supabase.from("algorithms").select("id, name");
  if (error) throw new Error(`prefix resolution failed: ${error.message}`);

  const resolved = [...full];
  for (const p of prefixes) {
    const needle = p.toLowerCase();
    const matches = ((all ?? []) as Array<{ id: string; name: string }>).filter((r) =>
      r.id.startsWith(needle)
    );
    if (matches.length === 0) {
      throw new Error(`ALGO_IDS prefix "${p}" matched no algorithms.`);
    }
    if (matches.length > 1) {
      const detail = matches.map((r) => `${r.id} (${r.name})`).join(", ");
      throw new Error(`ALGO_IDS prefix "${p}" is ambiguous — matched: ${detail}`);
    }
    console.log(`  resolved prefix "${p}" → ${matches[0].id} (${matches[0].name})`);
    resolved.push(matches[0].id);
  }
  return resolved;
}

async function main() {
  if (ALGO_IDS.length === 0 && ALGO_NAMES.length === 0) {
    console.error("Pass ALGO_IDS or ALGO_NAMES env. Discover via `pnpm dlx tsx scripts/live-state.ts`.");
    process.exit(1);
  }

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

  console.log(
    `Mode: ${APPLY ? "APPLY (will UPDATE)" : "DRY RUN (no writes)"}\n` +
      `Targets: ${ALGO_IDS.length > 0 ? `IDs ${ALGO_IDS.join(", ")}` : `names ${ALGO_NAMES.join(", ")}`}\n` +
      `Gate to add: block_joint discount ∩ london(7-13) ∩ compressed, shadow=true\n`
  );

  const resolvedIds =
    ALGO_IDS.length > 0 ? await resolveAlgoIds(supabase, ALGO_IDS) : [];

  // Read targets. Allow either filter.
  let query = supabase.from("algorithms").select("id, name, status, rules");
  if (resolvedIds.length > 0) query = query.in("id", resolvedIds);
  else query = query.in("name", ALGO_NAMES);
  const { data: rows, error: readErr } = await query;
  if (readErr) throw new Error(`read failed: ${readErr.message}`);
  if (!rows || rows.length === 0) {
    console.error("No matching algorithms found.");
    process.exit(1);
  }

  let updated = 0;
  let skippedExistingGate = 0;
  let skippedAlreadyDeployed = 0;

  for (const row of rows as Array<{
    id: string;
    name: string;
    status: string;
    rules: Record<string, unknown>;
  }>) {
    const existing = row.rules.market_state_gate;
    console.log(`\n--- ${row.name} (${row.id.slice(0, 8)}…, status=${row.status}) ---`);
    console.log(`  existing market_state_gate: ${JSON.stringify(existing ?? null)}`);

    // Idempotency: if the EXACT target gate is already deployed, skip.
    if (
      existing &&
      JSON.stringify(canonicalize(existing)) ===
        JSON.stringify(canonicalize(TARGET_GATE))
    ) {
      console.log("  ✓ target gate ALREADY DEPLOYED — skipping.");
      skippedAlreadyDeployed++;
      continue;
    }

    // Safety: refuse to overwrite a DIFFERENT existing gate.
    if (existing && Object.keys(existing as Record<string, unknown>).length > 0) {
      console.log(
        "  ⚠️  algorithm has a DIFFERENT existing market_state_gate — needs gate composition (queued follow-up). SKIPPING."
      );
      skippedExistingGate++;
      continue;
    }

    const newRules = { ...row.rules, market_state_gate: TARGET_GATE };
    console.log(`  proposed market_state_gate: ${JSON.stringify(TARGET_GATE)}`);

    if (!APPLY) {
      console.log("  (dry run — no write)");
      continue;
    }

    const { error: updErr } = await supabase
      .from("algorithms")
      .update({ rules: newRules })
      .eq("id", row.id);
    if (updErr) {
      console.error(`  ✗ update failed: ${updErr.message}`);
      continue;
    }
    console.log("  ✓ updated.");
    updated++;
  }

  console.log("\n=== Summary ===");
  console.log(`  matched: ${rows.length}`);
  console.log(`  updated: ${updated}`);
  console.log(`  skipped (already deployed): ${skippedAlreadyDeployed}`);
  console.log(`  skipped (existing gate, needs composition): ${skippedExistingGate}`);

  if (APPLY && updated > 0) {
    console.log(
      "\nNext: tail activity_log for `signal_no_action` events with " +
        "details.reason='market_state_gate_shadow'. Once ~10-20 shadow " +
        "blocks accumulate, compare to V1.2 signature (n=74, R=-0.76) " +
        "before flipping shadow:false to enforce."
    );
  } else if (!APPLY) {
    console.log("\nDry run complete. Re-run with APPLY=1 to commit.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
