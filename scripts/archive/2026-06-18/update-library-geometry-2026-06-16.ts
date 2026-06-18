/**
 * Apply geometry updates from 2026-06-16 retroactive 4-way revalidation.
 *
 * See scripts/REVALIDATION_REPORT_2026_06_16.md for the full findings.
 *
 * Two paper algos updated (no LIVE changes in this script):
 *   1. Library: Gold FVG-Long 30m
 *      stop_loss.lookback: 4 → 3
 *      Rationale: +42% total return ($26,775 vs $18,889), same 75% green.
 *
 *   2. Library: Gold Coil-Breakout 4h
 *      take_profit.value: 3 → 2
 *      stop_loss.lookback: 4 → 3
 *      Rationale: +140% total return ($25,879 vs $10,782), 62.5% vs 51.7%
 *      green, positive EVERY year of 6yr corpus (vs current's 2025 loss).
 *      Same chop-rescue mechanism as FVG-DailyBias-Long 4h.
 *
 * Both algos are PAPER (live_trading_enabled=false), so the update is
 * reversible by re-applying with the old values. The script verifies
 * current state before update, applies idempotently (no-op if already
 * at target), and verifies post-update.
 *
 * Safety:
 *   - DRY RUN by default. Pass APPLY=1 to actually update.
 *   - REFUSES if either target is live_trading_enabled=true (this script
 *     is explicitly paper-only per the report's "no live changes" verdict).
 *
 * Env required in .env.local:
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * Usage:
 *   pnpm dlx tsx scripts/update-library-geometry-2026-06-16.ts            # dry run
 *   APPLY=1 pnpm dlx tsx scripts/update-library-geometry-2026-06-16.ts    # commit
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

interface Update {
  algo_name: string;
  /** Path through the rules JSON, dot-separated. */
  path: string;
  from_value: number;
  to_value: number;
}

const UPDATES: Update[] = [
  {
    algo_name: "Library: Gold FVG-Long 30m",
    path: "stop_loss.lookback",
    from_value: 4,
    to_value: 3,
  },
  {
    algo_name: "Library: Gold Coil-Breakout 4h",
    path: "take_profit.value",
    from_value: 3,
    to_value: 2,
  },
  {
    algo_name: "Library: Gold Coil-Breakout 4h",
    path: "stop_loss.lookback",
    from_value: 4,
    to_value: 3,
  },
];

function getByPath(obj: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc && typeof acc === "object" && key in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}

function setByPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split(".");
  let cursor: Record<string, unknown> = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (!(k in cursor) || typeof cursor[k] !== "object" || cursor[k] === null) {
      throw new Error(`path ${path} broken at segment '${k}'`);
    }
    cursor = cursor[k] as Record<string, unknown>;
  }
  cursor[keys[keys.length - 1]] = value;
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

  // Group updates by algo for a single fetch+update cycle each.
  const byAlgo = new Map<string, Update[]>();
  for (const u of UPDATES) {
    if (!byAlgo.has(u.algo_name)) byAlgo.set(u.algo_name, []);
    byAlgo.get(u.algo_name)!.push(u);
  }

  for (const [algoName, updates] of byAlgo) {
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
    if (algo.live_trading_enabled) {
      console.error(
        `  ✗ REFUSED — algo has live_trading_enabled=true. This script is paper-only by design. Open a separate PR + A/B observation before flipping live geometry.\n`
      );
      continue;
    }

    const rules = JSON.parse(JSON.stringify(algo.rules));
    const planSummary: string[] = [];
    let alreadyApplied = true;
    let willChange = false;

    for (const u of updates) {
      const current = getByPath(rules, u.path);
      if (current === u.to_value) {
        planSummary.push(`  ✓ ${u.path} ALREADY ${u.to_value} (no-op)`);
        continue;
      }
      if (current !== u.from_value) {
        console.error(
          `  ✗ ${u.path}: expected ${u.from_value}, got ${current}. ABORTING this algo (other algos still attempted).`
        );
        alreadyApplied = false;
        willChange = false;
        break;
      }
      setByPath(rules, u.path, u.to_value);
      planSummary.push(`  → ${u.path}: ${u.from_value} → ${u.to_value}`);
      alreadyApplied = false;
      willChange = true;
    }

    if (alreadyApplied) {
      console.log(`  ✓ All updates already applied. Skipping.\n`);
      continue;
    }
    if (!willChange) {
      console.log("\n");
      continue;
    }

    console.log(planSummary.join("\n"));

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
