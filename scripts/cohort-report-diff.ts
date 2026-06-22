/**
 * Cohort-report diff CLI — SG.6.2 closure (2026-06-22 NIGHT LATE).
 *
 * Reads the latest TWO dated cohort-report JSONs under `scripts/` and
 * prints a human-readable diff of what changed: new/disappeared decay
 * flags + new/disappeared shadow-gate candidates + trade-count growth.
 *
 * Usage:
 *   pnpm dlx tsx scripts/cohort-report-diff.ts
 *   # → diffs the latest two dated JSONs
 *
 *   pnpm dlx tsx scripts/cohort-report-diff.ts <prior.json> <latest.json>
 *   # → explicit pair
 *
 * Run AFTER `cohort-report-cron.sh` fires (Sundays 23:00 UTC). The cron
 * itself does NOT run the diff — keeping concerns separate so the diff
 * can be re-run on any file pair without re-running the cohort cron.
 *
 * Exit codes:
 *   0 — quiet diff (no changes) OR changes printed cleanly
 *   1 — fatal (e.g. file not found, schema mismatch, JSON parse error)
 *
 * Schema requirement: both files must be POST-SG.6.1 CohortReport shape
 * (typed arrays for dimensions / decay_flags / shadow_gate_candidates).
 * Pre-SG.6.1 dated files use nested Records and `string[]` for flags —
 * the script rejects them with a clear pointer to the SG.6.1 boundary.
 */
import { readFileSync, readdirSync } from "fs";
import { resolve, basename } from "path";
import {
  diffCohortReports,
  isQuietDiff,
  type CohortReportDiff,
} from "../src/lib/cohort/cohort-report-diff";
import type { CohortReport } from "../src/lib/cohort/cohort-report";

const SCRIPTS_DIR = resolve(__dirname);

function findLatestDatedReports(): { prior: string; latest: string } {
  const files = readdirSync(SCRIPTS_DIR)
    .filter((f) => /^cohort-report-\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort(); // lexical sort = chronological (YYYY-MM-DD prefix)
  if (files.length < 2) {
    throw new Error(
      `Need at least 2 dated cohort-report JSON files in ${SCRIPTS_DIR} (found ${files.length}). Run cohort-report.ts at least twice (a week apart) before diffing.`
    );
  }
  return {
    prior: resolve(SCRIPTS_DIR, files[files.length - 2]),
    latest: resolve(SCRIPTS_DIR, files[files.length - 1]),
  };
}

function loadAndValidate(path: string): CohortReport {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    throw new Error(
      `Failed to read ${path}: ${e instanceof Error ? e.message : String(e)}`
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(
      `Invalid JSON in ${path}: ${e instanceof Error ? e.message : String(e)}`
    );
  }
  // Shape check — post-SG.6.1 reports have typed-array dimensions etc.
  // Pre-SG.6.1 reports have nested Records for dimensions — reject with
  // a clear pointer.
  const r = parsed as Partial<CohortReport>;
  if (!Array.isArray(r.dimensions) || !Array.isArray(r.decay_flags) || !Array.isArray(r.shadow_gate_candidates)) {
    throw new Error(
      `${basename(path)} appears to use the pre-SG.6.1 schema (nested Records). diffCohortReports requires the typed-array shape from SG.6.1+. Re-run cohort-report.ts to regenerate this file under the new schema.`
    );
  }
  return parsed as CohortReport;
}

function printDiff(prior_path: string, latest_path: string, diff: CohortReportDiff): void {
  console.log(`Cohort-report diff:`);
  console.log(`  prior:  ${basename(prior_path)} (${diff.prior_generated_at})`);
  console.log(`  latest: ${basename(latest_path)} (${diff.latest_generated_at})`);
  console.log(`  trade growth: ${diff.trade_growth >= 0 ? "+" : ""}${diff.trade_growth}\n`);

  if (isQuietDiff(diff)) {
    console.log("✓ No actionable changes — cohort surface stable across the two snapshots.");
    return;
  }

  if (diff.new_decay_flags.length > 0) {
    console.log(`⚠ NEW decay flags (${diff.new_decay_flags.length}) — cohort decayed THIS run:`);
    for (const f of diff.new_decay_flags) {
      console.log(
        `    ${f.dimension}=${f.value}: meanR ${f.prior_mean_r.toFixed(2)}→${f.recent_mean_r.toFixed(2)}, WR ${f.prior_wr_pct.toFixed(0)}%→${f.recent_wr_pct.toFixed(0)}% (n ${f.prior_n}→${f.recent_n})`
      );
    }
    console.log("");
  }

  if (diff.disappeared_decay_flags.length > 0) {
    console.log(
      `✓ DISAPPEARED decay flags (${diff.disappeared_decay_flags.length}) — cohort recovered OR fell out of n≥min_n eligibility:`
    );
    for (const f of diff.disappeared_decay_flags) {
      console.log(`    ${f.dimension}=${f.value}`);
    }
    console.log("");
  }

  if (diff.new_shadow_candidates.length > 0) {
    console.log(
      `→ NEW shadow-gate candidates (${diff.new_shadow_candidates.length}) — crossed the n≥8/meanR≤−0.3 line:`
    );
    for (const c of diff.new_shadow_candidates) {
      console.log(`    ${c.dimension}=${c.value} (n=${c.n}, meanR ${c.mean_r.toFixed(2)})`);
    }
    console.log("");
  }

  if (diff.disappeared_shadow_candidates.length > 0) {
    console.log(
      `✓ DISAPPEARED shadow-gate candidates (${diff.disappeared_shadow_candidates.length}) — cohort improved OR fell out:`
    );
    for (const c of diff.disappeared_shadow_candidates) {
      console.log(`    ${c.dimension}=${c.value}`);
    }
  }
}

function main(): void {
  const args = process.argv.slice(2);
  let priorPath: string;
  let latestPath: string;

  if (args.length === 2) {
    priorPath = resolve(args[0]);
    latestPath = resolve(args[1]);
  } else if (args.length === 0) {
    const { prior, latest } = findLatestDatedReports();
    priorPath = prior;
    latestPath = latest;
  } else {
    throw new Error(`Usage: cohort-report-diff.ts [<prior.json> <latest.json>]`);
  }

  const prior = loadAndValidate(priorPath);
  const latest = loadAndValidate(latestPath);
  const diff = diffCohortReports(prior, latest);
  printDiff(priorPath, latestPath, diff);
}

try {
  main();
} catch (e) {
  console.error(`Fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
