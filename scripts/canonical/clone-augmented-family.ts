/**
 * H.4b — Clone 96-variant Engulfing-Long Layer B family with augmented
 * entry_conditions (adds daily_bias-bullish PatternCondition).
 *
 * Why: H.4-methodology-revision feature-veto empirical showed
 * pattern_daily_bias_signed VL improves the v3 survivor's Sharpe by
 * +50.5% and cuts max-DD by -29.6% (preserving 99.8% of total R).
 * augmented-variant-validate confirmed all 7 per-candidate criteria
 * pass on the augmented v3 single variant. Next: clone the FULL
 * 96-variant family with the same augmentation so F (DSR/PBO/kfold)
 * + F2 (robustness) can run against the augmented family + verdict
 * whether the augmented v3 survivor is deployable.
 *
 * Naming convention (preserves geometry-tag for downstream survivor lookup):
 *   Source: "LayerB: XAU/USD Engulfing-Long 4h | rr3_lb6_r06_rf0_af0"
 *   Clone:  "LayerB+: XAU/USD Engulfing-Long-DBfilter 4h | rr3_lb6_r06_rf0_af0"
 *
 * Per-row mutations:
 *   - rules.entry_conditions: append {type, pattern: AUGMENT_PATTERN, direction, timeframe}
 *   - rules.entry_logic: locked to "all"
 *   - status: "draft" (matches source convention; never auto-active)
 *   - All other fields cloned verbatim from source (including capital, watchlist)
 *
 * Idempotent: re-running detects existing LayerB+ rows by name + skips them.
 *
 * Inserts:
 *   - algorithms row (with cloned + augmented rules JSONB)
 *   - algorithm_watchlist row (with same ticker as source)
 *
 * Usage:
 *   pnpm dlx tsx scripts/canonical/clone-augmented-family.ts
 *   DRY_RUN=1 pnpm dlx tsx scripts/canonical/clone-augmented-family.ts  # report only
 *
 * Env:
 *   SOURCE_FAMILY_PATTERN  default "LayerB: XAU/USD Engulfing-Long 4h | %"
 *   AUGMENT_PATTERN        default "daily_bias"
 *   AUGMENT_DIRECTION      default "bullish"
 *   AUGMENT_TIMEFRAME      default "4h" (matches algo's timeframe; override if needed)
 *   AUGMENTED_PREFIX       default "LayerB+:"
 *   AUGMENTED_TAG_SUFFIX   default "-DBfilter"  (appended to source's pattern-direction token)
 *   DRY_RUN                default 0  (set 1 to report counts without inserting)
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../../src/lib/supabase/database.types";
import type { AlgorithmRules, EntryCondition } from "../../src/types/algorithm";

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
  } catch { /* operator exports envs themselves */ }
}
loadEnvLocal();

const SOURCE_FAMILY_PATTERN =
  process.env.SOURCE_FAMILY_PATTERN ?? "LayerB: XAU/USD Engulfing-Long 4h | %";
const AUGMENT_PATTERN = process.env.AUGMENT_PATTERN ?? "daily_bias";
const AUGMENT_DIRECTION = (process.env.AUGMENT_DIRECTION ?? "bullish") as "bullish" | "bearish";
const AUGMENT_TIMEFRAME = process.env.AUGMENT_TIMEFRAME ?? "4h";
const AUGMENTED_PREFIX = process.env.AUGMENTED_PREFIX ?? "LayerB+:";
const AUGMENTED_TAG_SUFFIX = process.env.AUGMENTED_TAG_SUFFIX ?? "-DBfilter";
const DRY_RUN = process.env.DRY_RUN === "1";

function fail(msg: string): never {
  console.error(`[clone-augmented-family] ${msg}`);
  process.exit(1);
}

function requireEnv(): { url: string; key: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    fail("NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (preferred) or NEXT_PUBLIC_SUPABASE_ANON_KEY required");
  }
  return { url, key };
}

/** Build the augmented name from source name. Replace the "Engulfing-Long"
 *  token with "Engulfing-Long-DBfilter" + swap "LayerB:" → "LayerB+:". */
function buildAugmentedName(sourceName: string): string {
  // "LayerB: XAU/USD Engulfing-Long 4h | rr3_lb6_r06_rf0_af0"
  //   → "LayerB+: XAU/USD Engulfing-Long-DBfilter 4h | rr3_lb6_r06_rf0_af0"
  const withNewPrefix = sourceName.replace(/^LayerB:\s*/, `${AUGMENTED_PREFIX} `);
  // Find the pattern-direction token between TICKER and TF.
  // Pattern: "<TICKER> <PatternName>-<Direction> <TF> | <tag>"
  return withNewPrefix.replace(
    /^(\S+\s+\S+\s+[A-Za-z][A-Za-z]*(?:-[A-Za-z]+)*-(?:Long|Short))(\s+\d+[mh])/,
    (_, patternDirToken: string, tf: string) => `${patternDirToken}${AUGMENTED_TAG_SUFFIX}${tf}`,
  );
}

function buildAugmentedRules(sourceRules: AlgorithmRules): AlgorithmRules {
  // Append daily_bias-bullish PatternCondition; lock entry_logic to "all"
  // so both Engulfing AND daily_bias must fire to enter.
  const augmentCondition: EntryCondition = {
    type: "pattern",
    pattern: AUGMENT_PATTERN as never,
    direction: AUGMENT_DIRECTION,
    timeframe: AUGMENT_TIMEFRAME,
  };
  return {
    ...sourceRules,
    entry_conditions: [...sourceRules.entry_conditions, augmentCondition],
    entry_logic: "all",
  };
}

interface SourceRow {
  id: string;
  user_id: string;
  name: string;
  rules: AlgorithmRules;
  capital: number;
  ticker: string;
}

interface InsertResult {
  source_name: string;
  augmented_name: string;
  action: "inserted" | "exists-skipped" | "would-insert" | "error";
  error?: string;
  augmented_id?: string;
}

async function main(): Promise<void> {
  const { url, key } = requireEnv();
  const supabase: SupabaseClient<Database> = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  console.log(`[clone-augmented-family] H.4b augmented family clone`);
  console.log(`  source family    : ${SOURCE_FAMILY_PATTERN}`);
  console.log(`  augment pattern  : ${AUGMENT_PATTERN}-${AUGMENT_DIRECTION} ${AUGMENT_TIMEFRAME}`);
  console.log(`  augmented prefix : ${AUGMENTED_PREFIX}`);
  console.log(`  augmented tag    : ${AUGMENTED_TAG_SUFFIX}`);
  console.log(`  dry run          : ${DRY_RUN}`);
  console.log("");

  // 1. Load source family
  const { data: sourceRows, error: srcErr } = await supabase
    .from("algorithms")
    .select("id, user_id, name, rules, capital, algorithm_watchlist(ticker)")
    .like("name", SOURCE_FAMILY_PATTERN);
  if (srcErr) fail(`failed to fetch source family: ${srcErr.message}`);
  if (!sourceRows || sourceRows.length === 0) {
    fail(`no source rows matched '${SOURCE_FAMILY_PATTERN}'`);
  }

  const sources: SourceRow[] = sourceRows
    .map((r) => {
      const watchlist = (r.algorithm_watchlist ?? []) as { ticker: string }[];
      if (watchlist.length === 0) return null;
      return {
        id: r.id,
        user_id: r.user_id,
        name: r.name,
        rules: r.rules as unknown as AlgorithmRules,
        capital: Number(r.capital),
        ticker: watchlist[0].ticker,
      };
    })
    .filter((r): r is SourceRow => r !== null);

  console.log(`Loaded ${sources.length} source rows (of ${sourceRows.length} matching family)`);

  // 2. Check existing augmented rows
  const augmentedNames = sources.map((s) => buildAugmentedName(s.name));
  const { data: existingRows, error: existErr } = await supabase
    .from("algorithms")
    .select("name")
    .in("name", augmentedNames);
  if (existErr) fail(`existing-row check failed: ${existErr.message}`);
  const existing = new Set((existingRows ?? []).map((r) => r.name));
  console.log(`  existing augmented rows: ${existing.size} (will skip)`);

  // 3. Build insert payloads
  const results: InsertResult[] = [];
  for (const src of sources) {
    const augName = buildAugmentedName(src.name);
    if (existing.has(augName)) {
      results.push({
        source_name: src.name,
        augmented_name: augName,
        action: "exists-skipped",
      });
      continue;
    }

    if (DRY_RUN) {
      results.push({
        source_name: src.name,
        augmented_name: augName,
        action: "would-insert",
      });
      continue;
    }

    const augmentedRules = buildAugmentedRules(src.rules);
    // Insert algorithm row
    const { data: insertedRow, error: insErr } = await supabase
      .from("algorithms")
      .insert({
        user_id: src.user_id,
        name: augName,
        rules: augmentedRules as unknown as Database["public"]["Tables"]["algorithms"]["Insert"]["rules"],
        capital: src.capital,
        status: "draft",
      })
      .select("id")
      .single();
    if (insErr || !insertedRow) {
      results.push({
        source_name: src.name,
        augmented_name: augName,
        action: "error",
        error: insErr?.message ?? "insert returned no row",
      });
      continue;
    }
    // Insert algorithm_watchlist row
    const { error: wlErr } = await supabase
      .from("algorithm_watchlist")
      .insert({
        algorithm_id: insertedRow.id,
        user_id: src.user_id,
        ticker: src.ticker,
        added_by: "ai",
      });
    if (wlErr) {
      results.push({
        source_name: src.name,
        augmented_name: augName,
        action: "error",
        error: `algo inserted but watchlist failed: ${wlErr.message}`,
        augmented_id: insertedRow.id,
      });
      continue;
    }
    results.push({
      source_name: src.name,
      augmented_name: augName,
      action: "inserted",
      augmented_id: insertedRow.id,
    });
  }

  // 4. Report
  const counts = { inserted: 0, "exists-skipped": 0, "would-insert": 0, error: 0 };
  for (const r of results) counts[r.action]++;
  console.log("");
  console.log(`Action counts: ${JSON.stringify(counts)}`);
  if (counts.error > 0) {
    console.log("");
    console.log("ERRORS:");
    for (const r of results.filter((x) => x.action === "error")) {
      console.log(`  ${r.augmented_name}`);
      console.log(`    ${r.error}`);
    }
  }
  console.log("");
  console.log(`Augmented family pattern: '${AUGMENTED_PREFIX} %DBfilter%'`);
  console.log(`Survivor name (tag preserved): '${AUGMENTED_PREFIX} XAU/USD Engulfing-Long${AUGMENTED_TAG_SUFFIX} 4h | rr3_lb6_r06_rf0_af0'`);
  console.log("");
  console.log("Next:");
  console.log("  1. pnpm dlx tsx scripts/canonical/validate-algo.ts ALGOS='<csv of augmented names>' PERSIST=1");
  console.log("  2. pnpm dlx tsx scripts/canonical/revalidate-candidates.ts TARGETS='<augmented v3 survivor name>'");
  console.log("  3. F2 drivers: FAMILY_PATTERN='LayerB+: XAU/USD Engulfing-Long-DBfilter 4h | %' SURVIVOR_TAG='rr3_lb6_r06_rf0_af0'");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
