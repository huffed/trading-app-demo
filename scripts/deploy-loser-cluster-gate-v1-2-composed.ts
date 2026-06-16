/**
 * Composed-deploy follow-up to `deploy-loser-cluster-gate-v1-2.ts`.
 *
 * The original v1.2 script refuses to overwrite algos that already carry
 * a `rules.market_state_gate`. This script handles those — it COMPOSES
 * the V1.2 loser-cluster shadow clause AND with the existing gate
 * (`feat/market-state-gate-compositor` shape, `clauses[]`).
 *
 * Composite shape written:
 *
 *   {
 *     "clauses": [
 *       <existing single-clause gate>,           // enforced as-is
 *       <V1.2 block_joint clause, shadow:true>   // shadows new refusals
 *     ]
 *     // composite-level shadow OMITTED — engine respects per-clause
 *     // shadow, so the existing clause stays enforced and the V1.2
 *     // clause shadows.
 *   }
 *
 * Safety:
 *   - DRY RUN by default. Pass APPLY=1 to actually update.
 *   - Refuses to touch algos whose existing gate is ALREADY a composite
 *     containing the V1.2 clause (idempotent).
 *   - Refuses to touch algos with no existing gate (use the v1.2 script
 *     for those).
 *   - UUID prefix resolution + canonical idempotency check (Postgres
 *     JSONB reorders keys on storage).
 *
 * Usage:
 *   ALGO_IDS=20654d20,2551f803 pnpm dlx tsx scripts/deploy-loser-cluster-gate-v1-2-composed.ts
 *   APPLY=1 ALGO_IDS=20654d20,2551f803 pnpm dlx tsx scripts/deploy-loser-cluster-gate-v1-2-composed.ts
 *
 * Targets (live as of 2026-06-16, post-PR #239):
 *   20654d20  Library: Gold Bear-Short Sentinel 4h  (allow-mode mtf=aligned_LH)
 *   2551f803  Library: Gold Dip-Buyer 4h            (block-mode dxy=usd_down + mtf=fast_div_bull)
 *
 * After APPLY: tail activity_log for `signal_no_action` events with
 * details.gate_mode='composite_and' or details.reason='market_state_gate_shadow'
 * on these algos. Shadow blocks on the V1.2 clause surface alongside any
 * hard refusals from the enforced clause.
 */
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";

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

const V1_2_CLAUSE = {
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

const canonV12 = JSON.stringify(canonicalize(V1_2_CLAUSE));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function resolveAlgoIds(supabase: any, ids: string[]): Promise<string[]> {
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

function isCompositeShape(v: unknown): v is { clauses: unknown[]; shadow?: boolean } {
  return (
    typeof v === "object" &&
    v !== null &&
    Array.isArray((v as { clauses?: unknown }).clauses)
  );
}

async function main() {
  if (ALGO_IDS.length === 0) {
    console.error("Pass ALGO_IDS env. Discover via `pnpm dlx tsx scripts/live-state.ts`.");
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
      `Targets: IDs ${ALGO_IDS.join(", ")}\n` +
      `Action: wrap existing gate + V1.2 clause into a composite, shadow=per-clause\n`
  );

  const resolvedIds = await resolveAlgoIds(supabase, ALGO_IDS);

  const { data: rows, error: readErr } = await supabase
    .from("algorithms")
    .select("id, name, status, rules")
    .in("id", resolvedIds);
  if (readErr) throw new Error(`read failed: ${readErr.message}`);
  if (!rows || rows.length === 0) {
    console.error("No matching algorithms found.");
    process.exit(1);
  }

  let updated = 0;
  let skippedAlreadyComposed = 0;
  let skippedNoGate = 0;
  let skippedV12Solo = 0;

  for (const row of rows as Array<{
    id: string;
    name: string;
    status: string;
    rules: Record<string, unknown>;
  }>) {
    const existing = row.rules.market_state_gate;
    console.log(`\n--- ${row.name} (${row.id.slice(0, 8)}…, status=${row.status}) ---`);
    console.log(`  existing market_state_gate: ${JSON.stringify(existing ?? null)}`);

    if (existing == null) {
      console.log(
        "  ⚠️  algorithm has NO existing gate — use deploy-loser-cluster-gate-v1-2.ts instead. SKIPPING."
      );
      skippedNoGate++;
      continue;
    }

    if (JSON.stringify(canonicalize(existing)) === canonV12) {
      console.log(
        "  ✓ algorithm already carries V1.2 clause as a SOLO gate — no composition needed. SKIPPING."
      );
      skippedV12Solo++;
      continue;
    }

    if (isCompositeShape(existing)) {
      const hasV12 = existing.clauses.some(
        (c) => JSON.stringify(canonicalize(c)) === canonV12
      );
      if (hasV12) {
        console.log("  ✓ composite already contains V1.2 clause — SKIPPING.");
        skippedAlreadyComposed++;
        continue;
      }
      const composed = { ...existing, clauses: [...existing.clauses, V1_2_CLAUSE] };
      console.log(`  proposed composite: ${JSON.stringify(composed)}`);
      if (!APPLY) {
        console.log("  (dry run — no write)");
        continue;
      }
      const { error: updErr } = await supabase
        .from("algorithms")
        .update({ rules: { ...row.rules, market_state_gate: composed } })
        .eq("id", row.id);
      if (updErr) {
        console.error(`  ✗ update failed: ${updErr.message}`);
        continue;
      }
      console.log("  ✓ updated (appended to existing composite).");
      updated++;
      continue;
    }

    const composite = { clauses: [existing, V1_2_CLAUSE] };
    console.log(`  proposed composite: ${JSON.stringify(composite)}`);
    if (!APPLY) {
      console.log("  (dry run — no write)");
      continue;
    }
    const { error: updErr } = await supabase
      .from("algorithms")
      .update({ rules: { ...row.rules, market_state_gate: composite } })
      .eq("id", row.id);
    if (updErr) {
      console.error(`  ✗ update failed: ${updErr.message}`);
      continue;
    }
    console.log("  ✓ updated (wrapped single-clause into composite).");
    updated++;
  }

  console.log("\n=== Summary ===");
  console.log(`  matched:                       ${rows.length}`);
  console.log(`  updated:                       ${updated}`);
  console.log(`  skipped (no existing gate):    ${skippedNoGate}`);
  console.log(`  skipped (V1.2 solo, no compose needed): ${skippedV12Solo}`);
  console.log(`  skipped (composite already has V1.2):   ${skippedAlreadyComposed}`);

  if (APPLY && updated > 0) {
    console.log(
      "\nNext: tail activity_log for `signal_no_action` with " +
        "details.gate_mode='composite_and' (hard refusals from enforced " +
        "clauses) or details.reason='market_state_gate_shadow' (V1.2 " +
        "would-blocks)."
    );
  } else if (!APPLY) {
    console.log("\nDry run complete. Re-run with APPLY=1 to commit.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
