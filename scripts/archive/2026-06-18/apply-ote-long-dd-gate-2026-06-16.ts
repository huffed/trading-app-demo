/**
 * Apply G3 regime gate to `Library: Gold OTE-Long 4h` to bring DD
 * under FTMO 10% cap.
 *
 * Per S1.5 priority #5 investigation (scripts/regime-decomp-ote-long.ts):
 *
 *   Ungated baseline: 6yr peak-to-trough DD 11.59% — over FTMO 10% cap.
 *   G3 gate (block dxy=usd_down OR mtf=fast_div_bull): DD 6.68%,
 *   82% of total R preserved ($35.6K → $29.0K), per-trade mean R
 *   IMPROVES (0.284 → 0.331). Per-year worst DD 6.68% — well under
 *   FTMO rolling DD limit too.
 *
 * Same gate structure as Dip-Buyer 4h (LIVE) — proven config shape.
 *
 * Forex caveat: OTE-Long is gold-specific (negative R on every forex
 * pair under every gate). This gate is XAU-only. OTE-Long 4h algo
 * is XAU-watchlist-only so this is fine; if it ever gets a forex
 * watchlist row, the gate should be revisited.
 *
 * Safety:
 *   - DRY RUN by default. APPLY=1 to commit.
 *   - REFUSES live_trading_enabled=true. OTE-Long 4h is paper; this
 *     check is defense-in-depth in case the flag flips before this
 *     script runs.
 *   - Idempotent: verifies current state has no gate before applying.
 *
 * Env required:
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * Usage:
 *   pnpm dlx tsx scripts/apply-ote-long-dd-gate-2026-06-16.ts        # dry run
 *   APPLY=1 pnpm dlx tsx scripts/apply-ote-long-dd-gate-2026-06-16.ts
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
const TARGET = "Library: Gold OTE-Long 4h";

const G3_GATE = {
  mode: "block" as const,
  states: {
    dxy: ["usd_down"],
    mtf: ["fast_div_bull"],
  },
  on_unreadable: "allow" as const,
};

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
  }
  const supabase = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  console.log(`Mode: ${APPLY ? "APPLY (will UPDATE)" : "DRY RUN (no writes)"}\n`);

  const { data: algo, error } = await supabase
    .from("algorithms")
    .select("id, rules, live_trading_enabled, status")
    .eq("name", TARGET)
    .maybeSingle();
  if (error || !algo) {
    throw new Error(`fetch failed: ${error?.message ?? "row not found"}`);
  }

  console.log(`Target: ${TARGET}`);
  console.log(`  id: ${algo.id}`);
  console.log(`  status: ${algo.status}`);
  console.log(`  live_trading_enabled: ${algo.live_trading_enabled}`);

  if (algo.live_trading_enabled) {
    throw new Error(
      "REFUSED — algo has live_trading_enabled=true. This script is paper-only by design. " +
        "Live geometry change requires A/B paper variant alongside live for ~30 days first " +
        "(per feedback_iterate_only_validated_baselines)."
    );
  }

  const rules = JSON.parse(JSON.stringify(algo.rules)) as Record<string, unknown>;
  const existingGate = rules.market_state_gate;

  if (existingGate) {
    console.log(`\n  current gate: ${JSON.stringify(existingGate)}`);
    if (JSON.stringify(existingGate) === JSON.stringify(G3_GATE)) {
      console.log(`\n  ✓ G3 gate already applied — no-op`);
      return;
    }
    console.log(`\n  ✗ REFUSED — algo already has a different gate. Manual review required.`);
    return;
  }

  rules.market_state_gate = G3_GATE;
  console.log(`\nProposed update:`);
  console.log(`  market_state_gate (new): ${JSON.stringify(G3_GATE)}`);
  console.log(`\nExpected impact (per regime-decomp-ote-long.ts):`);
  console.log(`  6yr peak-to-trough DD: 11.59% → 6.68% (-4.91pp)`);
  console.log(`  6yr worst-year DD: 8.03% → 6.68% (-1.35pp)`);
  console.log(`  Total R: $35,572 → $29,030 (82% preserved)`);
  console.log(`  Per-trade mean R: 0.284 → 0.331 (gate filters bad entries)`);
  console.log(`  Trade count: 209 → 146 (-30%)`);

  if (!APPLY) {
    console.log("\nDry run complete. Re-run with APPLY=1 to commit.");
    return;
  }

  const { error: updateErr } = await supabase
    .from("algorithms")
    .update({ rules })
    .eq("id", algo.id);
  if (updateErr) {
    throw new Error(`update failed: ${updateErr.message}`);
  }
  console.log(`\n✓ updated algo id=${algo.id.slice(0, 8)}…`);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
