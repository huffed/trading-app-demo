/**
 * E2.7.5 — Cell-coverage F2.2 with H.4b feature-augmented universe.
 *
 * Pre-registered in `phase-e2-sweep-lock.md` § E2.7.5 Addendum (locked
 * 2026-06-29 BEFORE empirical run). Parameters LOCKED:
 *
 *   GATE_THRESHOLD   = ≥3 augmented non-survivor passers per cell (same as F2.2)
 *   TOP_K            = 10 (H.4b default)
 *   MAX_FEATURES     = 4 (H.4b default; here, the per-pattern feature search width)
 *   MIN_TRADES_FLOOR = 30 (matches per-candidate criterion 2)
 *   AUGMENT_DIRECTION= "bullish" (all N=4 candidates are Long)
 *   AUGMENT_PATTERNS = top-K pattern_*_signed from H.3 feature importance
 *   PER_CANDIDATE_CRITERIA = 1-7 from `src/lib/algo-search/criteria.ts` (unchanged)
 *
 * METHODOLOGY (operator-stamped 2026-06-29 post-E2.7-empirical):
 *   F2.2's universal failure (4/4 candidates) at gold-only 4h cells is the
 *   binding constraint blocking ship-gate. Hypothesis: the UNAUGMENTED Layer A
 *   F2.2 test is too narrow — feature-augmented non-survivor patterns may
 *   produce per-candidate-passing signal that the unaugmented baseline doesn't.
 *   Tests cell-coverage WITH augmentation BEFORE relaxing thresholds (E2.8).
 *
 * METHOD (per cell):
 *   1. Enumerate non-survivor Search:* algos at (CELL_TICKER, CELL_TIMEFRAME,
 *      CELL_DIRECTION) — these are the OTHER patterns at the survivor's cell
 *   2. For each non-survivor algo:
 *      a. For each augmentation pattern in AUGMENT_PATTERNS (excluding the
 *         non-survivor's own pattern):
 *         - Spawn `augmented-variant-validate.ts` with ALGO_ID + AUGMENT_PATTERN
 *         - Read its JSON output: per_candidate_passes (true/false)
 *         - If passes → mark non-survivor algo as "augmented passer", break
 *   3. Count augmented passers; cell-verdict = pass_count ≥ GATE_THRESHOLD
 *
 * Wall clock: ~(N non-survivor patterns × M augment patterns × ~12s/run)
 *   per cell. For Engulfing cell (~13 non-survivor × 4 features × 12s):
 *   ~10 min. Aggressive early-exit on first passing feature per pattern.
 *
 * USAGE:
 *   CELL_SURVIVOR_PATTERN=engulfing pnpm dlx tsx scripts/canonical/e27.5-cell-coverage-augmented.ts
 *   CELL_SURVIVOR_PATTERN=asian_range_break pnpm dlx tsx scripts/canonical/e27.5-cell-coverage-augmented.ts
 *
 * Env (defaults match pre-reg):
 *   CELL_TICKER            default "XAU/USD"
 *   CELL_TIMEFRAME         default "4h"
 *   CELL_DIRECTION         default "Long"
 *   CELL_SURVIVOR_PATTERN  REQUIRED (lowercase, e.g. "engulfing" or "asian_range_break")
 *   TOP_K_AUGMENT_PATTERNS default 4 (use top-K pattern_*_signed from H.3 file)
 *   FEATURE_IMPORTANCE_FILE default scripts/canonical/feature-importance-results.json
 *   GATE_THRESHOLD         default 3
 *   AUGMENT_DIRECTION      default "bullish"
 *   OUTPUT_JSON            default scripts/canonical/e2-results/e27.5-cell-coverage/<survivor>.json
 *   PERSIST                default 1
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
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
  } catch { /* operator exports envs themselves */ }
}
loadEnvLocal();

const CELL_TICKER = process.env.CELL_TICKER ?? "XAU/USD";
const CELL_TIMEFRAME = process.env.CELL_TIMEFRAME ?? "4h";
const CELL_DIRECTION = process.env.CELL_DIRECTION ?? "Long";
const CELL_SURVIVOR_PATTERN = process.env.CELL_SURVIVOR_PATTERN;
const TOP_K_AUGMENT_PATTERNS = Math.max(1, Number(process.env.TOP_K_AUGMENT_PATTERNS ?? "4"));
const FEATURE_IMPORTANCE_FILE =
  process.env.FEATURE_IMPORTANCE_FILE ?? "scripts/canonical/feature-importance-results.json";
const GATE_THRESHOLD = Math.max(1, Number(process.env.GATE_THRESHOLD ?? "3"));
const AUGMENT_DIRECTION = process.env.AUGMENT_DIRECTION ?? "bullish";
const OUTPUT_JSON =
  process.env.OUTPUT_JSON ??
  `scripts/canonical/e2-results/e27.5-cell-coverage/${CELL_SURVIVOR_PATTERN ?? "unknown"}.json`;
const PERSIST = process.env.PERSIST !== "0";

if (!CELL_SURVIVOR_PATTERN) {
  console.error("CELL_SURVIVOR_PATTERN required (e.g. 'engulfing' or 'asian_range_break')");
  process.exit(1);
}

function requireEnv(): { url: string; key: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY required");
  }
  return { url, key };
}

/** Extract pattern name from "Search: TICKER PATTERN-DIR TF" → "pattern" (lowercase, snake). */
function extractPatternFromName(name: string): string | null {
  const m = name.match(/^Search:\s*\S+\s+([A-Za-z]+(?:[A-Z][a-z]+)*)-(Long|Short)\s+\d+[mh]$/);
  if (!m) return null;
  // CamelCase → snake_case
  return m[1]
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}

interface FeatureImportance {
  name: string;
  gain: number;
}

interface AugmentedValidateOutput {
  per_candidate_passes: boolean;
  per_candidate_results?: Array<{ criterion: string; passed: boolean; detail?: string }>;
  augmented?: {
    trades?: number;
    total_return?: number;
    sharpe?: number;
    max_static_dd_pct?: number;
    max_daily_dd_pct?: number;
    win_rate?: number;
  };
  augment_pattern?: string;
}

function loadTopAugmentPatterns(): string[] {
  const path = resolve(process.cwd(), FEATURE_IMPORTANCE_FILE);
  if (!existsSync(path)) {
    throw new Error(`feature-importance file not found: ${path}`);
  }
  const raw = JSON.parse(readFileSync(path, "utf-8")) as { top_features?: FeatureImportance[]; results?: FeatureImportance[] };
  const feats = raw.top_features ?? raw.results ?? [];
  // Only pattern_*_signed entries are addable as PatternCondition; strip prefix/suffix
  const patternFeats = feats
    .filter((f) => f.name.startsWith("pattern_") && f.name.endsWith("_signed"))
    .map((f) => f.name.replace(/^pattern_/, "").replace(/_signed$/, ""));
  return patternFeats.slice(0, TOP_K_AUGMENT_PATTERNS);
}

async function listNonSurvivorAlgos(
  sb: SupabaseClient<Database>,
): Promise<Array<{ id: string; name: string; pattern: string }>> {
  const tickerEscaped = CELL_TICKER.replace(/\//g, "/");
  const { data, error } = await sb
    .from("algorithms")
    .select("id, name")
    .like("name", `Search: ${tickerEscaped} %-${CELL_DIRECTION} ${CELL_TIMEFRAME}`);
  if (error || !data) {
    throw new Error(`fetch Search:* algos at cell: ${error?.message ?? "no data"}`);
  }
  const out: Array<{ id: string; name: string; pattern: string }> = [];
  for (const r of data) {
    const pattern = extractPatternFromName(r.name);
    if (!pattern) continue;
    if (pattern === CELL_SURVIVOR_PATTERN) continue; // skip survivor
    out.push({ id: r.id, name: r.name, pattern });
  }
  return out;
}

function runAugmentedValidate(
  algoId: string,
  augmentPattern: string,
): AugmentedValidateOutput | null {
  // Spawn augmented-variant-validate as subprocess with isolated OUTPUT_JSON
  const tmpOut = `/tmp/e27.5-aug-${algoId.slice(0, 8)}-${augmentPattern}.json`;
  const result = spawnSync(
    "pnpm",
    ["dlx", "tsx", "scripts/canonical/augmented-variant-validate.ts"],
    {
      env: {
        ...process.env,
        ALGO_ID: algoId,
        AUGMENT_PATTERN: augmentPattern,
        AUGMENT_DIRECTION,
        OUTPUT_JSON: tmpOut,
      },
      encoding: "utf-8",
      timeout: 120_000, // 2min per run is generous
    },
  );
  if (result.status !== 0) {
    console.error(
      `  augmented-validate failed (algo=${algoId.slice(0, 8)} pattern=${augmentPattern}): ${result.stderr?.slice(0, 200)}`,
    );
    return null;
  }
  if (!existsSync(tmpOut)) {
    console.error(`  augmented-validate produced no output at ${tmpOut}`);
    return null;
  }
  try {
    return JSON.parse(readFileSync(tmpOut, "utf-8")) as AugmentedValidateOutput;
  } catch (e) {
    console.error(`  failed to parse ${tmpOut}: ${(e as Error).message}`);
    return null;
  }
}

interface PerPatternResult {
  algo_id: string;
  algo_name: string;
  pattern: string;
  augmented_passer: boolean;
  passing_augmentation: string | null;
  metrics: AugmentedValidateOutput["augmented"] | null;
  tried_augmentations: Array<{
    augment_pattern: string;
    per_candidate_passes: boolean;
    failure_reasons?: string[];
  }>;
}

async function main(): Promise<void> {
  const { url, key } = requireEnv();
  const sb = createClient<Database>(url, key);

  console.log("E2.7.5 cell-coverage F2.2 with augmented universe");
  console.log(`  cell : ${CELL_TICKER} ${CELL_DIRECTION} ${CELL_TIMEFRAME}`);
  console.log(`  survivor pattern (excluded) : ${CELL_SURVIVOR_PATTERN}`);
  console.log(`  augment patterns (top-${TOP_K_AUGMENT_PATTERNS} from H.3) : pending load`);
  console.log(`  gate : ≥${GATE_THRESHOLD} non-survivor patterns must pass per-candidate when augmented`);
  console.log("");

  const augmentPatterns = loadTopAugmentPatterns();
  console.log(`  augment patterns loaded : ${augmentPatterns.join(", ")}`);
  console.log("");

  const nonSurvivors = await listNonSurvivorAlgos(sb);
  console.log(`Non-survivor Search:* algos at cell : ${nonSurvivors.length}`);
  for (const a of nonSurvivors) {
    console.log(`  - ${a.pattern.padEnd(20)} ${a.name}`);
  }
  console.log("");

  if (nonSurvivors.length === 0) {
    console.error("No non-survivor algos found at cell; aborting");
    process.exit(1);
  }

  console.log("Running augmentation × per-candidate evaluation:");
  const perPattern: PerPatternResult[] = [];

  for (const algo of nonSurvivors) {
    console.log(`  [${algo.pattern}]`);
    const tried: PerPatternResult["tried_augmentations"] = [];
    let passer = false;
    let passingAug: string | null = null;
    let passMetrics: AugmentedValidateOutput["augmented"] | null = null;

    for (const aug of augmentPatterns) {
      // Skip self-augmentation
      if (aug === algo.pattern) {
        console.log(`    × ${aug.padEnd(20)} (skip — self-augmentation)`);
        continue;
      }
      const out = runAugmentedValidate(algo.id, aug);
      if (out === null) {
        tried.push({ augment_pattern: aug, per_candidate_passes: false, failure_reasons: ["subprocess-error"] });
        console.log(`    ! ${aug.padEnd(20)} (subprocess error)`);
        continue;
      }
      const passes = out.per_candidate_passes === true;
      const failures = (out.per_candidate_results ?? [])
        .filter((c) => !c.passed)
        .map((c) => c.criterion + (c.detail ? ` (${c.detail})` : ""));
      tried.push({ augment_pattern: aug, per_candidate_passes: passes, failure_reasons: failures });
      const mark = passes ? "✓" : "✗";
      const sharpeStr = out.augmented?.sharpe?.toFixed(4) ?? "n/a";
      const tradesStr = out.augmented?.trades ?? "n/a";
      // max_static_dd_pct is in PERCENTAGE form (e.g., 13.19 = 13.19%) per
      // bug fix in augmented-variant-validate.ts (2026-06-29).
      const ddStr = out.augmented?.max_static_dd_pct
        ? `${out.augmented.max_static_dd_pct.toFixed(2)}%`
        : "n/a";
      console.log(
        `    ${mark} ${aug.padEnd(20)} trades=${tradesStr} sharpe=${sharpeStr} static_dd=${ddStr}`,
      );
      if (passes) {
        passer = true;
        passingAug = aug;
        passMetrics = out.augmented ?? null;
        break; // early exit on first passing augmentation
      }
    }

    perPattern.push({
      algo_id: algo.id,
      algo_name: algo.name,
      pattern: algo.pattern,
      augmented_passer: passer,
      passing_augmentation: passingAug,
      metrics: passMetrics,
      tried_augmentations: tried,
    });
  }

  const passers = perPattern.filter((p) => p.augmented_passer);
  const verdict: "PASS" | "FAIL" = passers.length >= GATE_THRESHOLD ? "PASS" : "FAIL";

  console.log("");
  console.log("=".repeat(72));
  console.log(`E2.7.5 cell ${CELL_TICKER} ${CELL_DIRECTION} ${CELL_TIMEFRAME} (survivor=${CELL_SURVIVOR_PATTERN}) VERDICT: ${verdict}`);
  console.log(`  augmented passers : ${passers.length} / ${perPattern.length} non-survivor patterns (need ≥${GATE_THRESHOLD})`);
  if (passers.length > 0) {
    console.log(`  passing patterns  :`);
    for (const p of passers) {
      console.log(`    ${p.pattern} (augmented with ${p.passing_augmentation})`);
    }
  }

  const output = {
    sub_gate: "E2.7.5 cell-coverage F2.2 (augmented universe)" as const,
    verdict,
    pass_count: passers.length,
    gate_threshold: GATE_THRESHOLD,
    cell: {
      ticker: CELL_TICKER,
      timeframe: CELL_TIMEFRAME,
      direction: CELL_DIRECTION,
      survivor_pattern: CELL_SURVIVOR_PATTERN,
    },
    augment_patterns_tried: augmentPatterns,
    augment_direction: AUGMENT_DIRECTION,
    feature_importance_file: FEATURE_IMPORTANCE_FILE,
    non_survivor_count: perPattern.length,
    per_pattern_results: perPattern,
    pre_registration: {
      lock_doc: "scripts/canonical/phase-e2-sweep-lock.md § E2.7.5 Addendum (2026-06-29)",
      gate_threshold: GATE_THRESHOLD,
      top_k_augment_patterns: TOP_K_AUGMENT_PATTERNS,
    },
    generated_at: new Date().toISOString(),
  };

  if (PERSIST) {
    mkdirSync(dirname(OUTPUT_JSON), { recursive: true });
    writeFileSync(OUTPUT_JSON, JSON.stringify(output, null, 2));
    console.log("");
    console.log(`Persisted ${OUTPUT_JSON}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
