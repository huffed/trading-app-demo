/**
 * Remove V1.2 cluster shadow gates from 5 deployed library algos
 * after historical replay (this PR) proved them functionally inert:
 *   - 4 binds total across 5 algos × 6yr corpus
 *   - $-1 aggregate P&L impact (rounding noise)
 *   - 0 binds observed in 48h of live shadow telemetry
 *
 * The V1.2 cluster finding (mining 2026-06-10, PR #239) is REAL at
 * portfolio level (n=74, p=0.000 Bonferroni) — but the cluster
 * signature (compressed ∩ discount ∩ london(7-13)) doesn't coincide
 * with these algos' entry signals at any meaningful rate. Per-algo
 * gates are the wrong architecture for a portfolio-level finding.
 * See project_discovery_v1_findings for the design lesson.
 *
 * Removal logic per algo:
 *   - Solo V1.2 gate (Coil-1h, FVG-Long 30m, FVG-DailyBias): DELETE
 *     market_state_gate entirely.
 *   - Composite gate where V1.2 is one of multiple clauses (Bear-Short,
 *     Dip-Buyer): filter clauses[] to drop the V1.2 signature; if only
 *     one clause remains, collapse to solo gate; if zero remain,
 *     delete market_state_gate.
 *
 * The enforcing (non-shadow) clauses in composite gates are PRESERVED:
 *   - Bear-Short: keeps `allow mtf=aligned_LH on_unreadable=block`
 *   - Dip-Buyer: keeps `block dxy=usd_down + mtf=fast_div_bull`
 *
 * Touches LIVE algos (Coil-1h, Dip-Buyer): the script-level live-flip
 * refusal in update-library-geometry-2026-06-16.ts targets GEOMETRY
 * changes (rr, lookback) which alter execution behavior. This script
 * removes pure-telemetry shadow gates that have been validated to have
 * 0 enforcement effect. Different policy.
 *
 * Safety:
 *   - DRY RUN by default. APPLY=1 to commit.
 *   - Each update fetches the rules, mutates a deep copy, verifies the
 *     V1.2 signature matches exactly before removing, and only writes
 *     if the rules actually changed. Idempotent.
 *
 * Usage:
 *   pnpm dlx tsx scripts/remove-v12-shadow-gates-2026-06-16.ts        # dry run
 *   APPLY=1 pnpm dlx tsx scripts/remove-v12-shadow-gates-2026-06-16.ts
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

const ALGO_NAMES = [
  "Library: Gold Bear-Short Sentinel 4h",
  "Library: Gold Coil-Breakout 1h",
  "Library: Gold Dip-Buyer 4h",
  "Library: Gold FVG-Long 30m",
  "Library: Gold FVG-DailyBias-Long 4h",
];

function isV12Clause(clause: Record<string, unknown>): boolean {
  if (clause.mode !== "block_joint") return false;
  if (clause.shadow !== true) return false;
  const states = clause.states as Record<string, string[]> | undefined;
  if (!states) return false;
  // Exact V1.2 signature: range=compressed ∩ entry_zone=discount ∩
  // entry_hour_bucket=london(7-13). Match strictly — don't remove
  // unrelated joint-shadow clauses that happen to be block_joint+shadow.
  const range = states.range;
  const zone = states.entry_zone;
  const hour = states.entry_hour_bucket;
  return (
    Array.isArray(range) && range.length === 1 && range[0] === "compressed" &&
    Array.isArray(zone) && zone.length === 1 && zone[0] === "discount" &&
    Array.isArray(hour) && hour.length === 1 && hour[0] === "london(7-13)"
  );
}

interface Plan {
  algo_name: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  removed_clauses: number;
  noop: boolean;
}

function planRemoval(rules: Record<string, unknown>): Plan {
  const gate = rules.market_state_gate as Record<string, unknown> | undefined;
  if (!gate) return { algo_name: "", before: null, after: null, removed_clauses: 0, noop: true };

  // Solo V1.2 gate
  if (!("clauses" in gate)) {
    if (isV12Clause(gate)) {
      return { algo_name: "", before: gate, after: null, removed_clauses: 1, noop: false };
    }
    return { algo_name: "", before: gate, after: gate, removed_clauses: 0, noop: true };
  }

  // Composite — filter clauses
  const clauses = (gate.clauses as Record<string, unknown>[]) ?? [];
  const kept = clauses.filter((c) => !isV12Clause(c));
  const removed = clauses.length - kept.length;
  if (removed === 0) {
    return { algo_name: "", before: gate, after: gate, removed_clauses: 0, noop: true };
  }
  if (kept.length === 0) {
    return { algo_name: "", before: gate, after: null, removed_clauses: removed, noop: false };
  }
  if (kept.length === 1) {
    return { algo_name: "", before: gate, after: kept[0], removed_clauses: removed, noop: false };
  }
  return {
    algo_name: "",
    before: gate,
    after: { ...gate, clauses: kept },
    removed_clauses: removed,
    noop: false,
  };
}

async function main() {
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

  console.log(`Mode: ${APPLY ? "APPLY (will UPDATE)" : "DRY RUN (no writes)"}\n`);

  for (const algoName of ALGO_NAMES) {
    console.log(`--- ${algoName} ---`);
    const { data: algo, error } = await supabase
      .from("algorithms")
      .select("id, rules, live_trading_enabled")
      .eq("name", algoName)
      .maybeSingle();
    if (error || !algo) {
      console.error(`  ✗ fetch failed: ${error?.message ?? "row not found"}\n`);
      continue;
    }

    const rules = JSON.parse(JSON.stringify(algo.rules)) as Record<string, unknown>;
    const plan = planRemoval(rules);
    plan.algo_name = algoName;

    if (plan.noop) {
      console.log(`  ✓ no V1.2 clause present — no-op\n`);
      continue;
    }

    if (plan.after === null) {
      delete rules.market_state_gate;
    } else {
      rules.market_state_gate = plan.after;
    }

    console.log(`  live_trading_enabled: ${algo.live_trading_enabled}`);
    console.log(`  removed ${plan.removed_clauses} V1.2 clause(s)`);
    console.log(`  before: ${JSON.stringify(plan.before)}`);
    console.log(`  after:  ${plan.after === null ? "(market_state_gate removed)" : JSON.stringify(plan.after)}`);

    if (!APPLY) {
      console.log("  (dry run — not writing)\n");
      continue;
    }

    const { error: updateErr } = await supabase
      .from("algorithms")
      .update({ rules })
      .eq("id", algo.id);
    if (updateErr) {
      console.error(`  ✗ update failed: ${updateErr.message}\n`);
      continue;
    }
    console.log(`  ✓ updated algo id=${algo.id.slice(0, 8)}…\n`);
  }

  if (!APPLY) {
    console.log("Dry run complete. Re-run with APPLY=1 to commit.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
