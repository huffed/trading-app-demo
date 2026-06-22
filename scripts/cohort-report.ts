/**
 * Cohort report — the learning loop's REVIEW layer ("notice diminishing
 * returns", fundamental #3). $0 to run: reads existing llm_decisions +
 * paper_positions rows, no LLM calls.
 *
 * What it does:
 *  1. Pulls completed LLM-trader entries (llm_decisions rows with a
 *     backfilled trade_outcome) and joins per-trade cohort tags from
 *     paper_positions.entry_reason (regime / entry_zone /
 *     position_in_range_pct / entry_hour_utc — attribution live since
 *     2026-05-18; older trades report as "untagged").
 *  2. Aggregates expectancy per cohort dimension: regime, prompt
 *     version, side, confidence bucket, session bucket, exit reason.
 *  3. DECAY FLAGS: compares the last DAYS-day window against the DAYS
 *     before it per cohort (n ≥ MIN_N in both halves) and flags mean-R
 *     drops ≥ 0.5R or WR drops ≥ 20pp.
 *  4. SHADOW-GATE CANDIDATES: cohorts with n ≥ 8 and mean R ≤ −0.3 —
 *     these become log-only engine gates first (scoped per
 *     algo + prompt_version per the gate-scoping lessons), and only
 *     flip to enforcing after weeks of shadow evidence.
 *  5. ENGINE ACTIVITY (always emitted, useful in pre-trade weeks):
 *     LLM decision distribution + confidence stats over the activity
 *     window, per-algo gate refusal / condition miss / drift refusal
 *     counts, and notable defensive saves (drift refusals with the
 *     would-have-entered side preserved). This is what keeps the
 *     report informative during the 30-day observation window between
 *     a config change and the first closed trade.
 *
 * SG.6.1 closure (2026-06-22 NIGHT LATE): aggregation logic in (1)-(4)
 * extracted to `src/lib/cohort/cohort-report.ts:buildCohortReport`.
 * This script now imports + delegates the aggregation, keeping only
 * the console-render + dated-JSON-write responsibilities. The /reports
 * Cohort tab reads the same buildCohortReport output — single source
 * of truth for cohort attribution math.
 *
 * **Dated-JSON schema change:** the per-dimension shape moved from
 * `Record<dim, Record<value, Agg>>` to `CohortDimensionReport[]` arrays
 * matching `CohortReport` types in the shared lib. Operator's gitignored
 * dated files written under the old schema won't diff cleanly across
 * the SG.6.1 boundary — first post-SG.6.1 dated file is the new
 * reference schema.
 *
 * Honesty rule: with small n the report SAYS "insufficient n" rather
 * than printing noise as signal. Cohort gates were reverted once
 * (#136/#137) for being calibrated on a single window — this report is
 * the cadence that prevents that class of mistake, not a license to
 * repeat it.
 *
 * Usage:
 *   pnpm dlx tsx scripts/cohort-report.ts
 *   DAYS=14      half-window length for decay comparison (default 14)
 *   SOURCE=live  llm_decisions source: live | walk_forward | all (default live)
 *   MIN_N=5      min trades per half-window for a decay comparison
 *
 * Cadence: weekly (or after any config change ships). Output JSON is
 * written next to the script (gitignored) for later diffing.
 */
import { readFileSync, writeFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import {
  buildCohortReport,
  type CohortBucket,
  type CohortDimensionReport,
} from "../src/lib/cohort/cohort-report";
import { buildEngineActivity, type EngineActivity } from "../src/lib/cohort/engine-activity";

// Self-load .env.local (same pattern as sibling scripts)
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

const DAYS = Number(process.env.DAYS ?? 14);
const SOURCE = (process.env.SOURCE ?? "live") as "live" | "walk_forward" | "all";
const MIN_N = Number(process.env.MIN_N ?? 5);
/** Window for the engine-activity section. Separate from DAYS (which
 *  governs the decay-comparison halves) so weekly review reads against
 *  the prior 7 days regardless of how trade history is being sliced. */
const ACTIVITY_DAYS = Number(process.env.ACTIVITY_DAYS ?? 7);

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !serviceKey) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

const pad = (s: string, n: number): string =>
  s.length >= n ? s : s + " ".repeat(n - s.length);

/** Engine activity printer — delegates aggregation to the shared
 *  src/lib/cohort/engine-activity.ts module so the in-UI /reports
 *  page reads from the same source of truth as the CLI. */
async function printEngineActivity(): Promise<EngineActivity> {
  const activity = await buildEngineActivity(supabase, ACTIVITY_DAYS);
  const {
    llm_decisions: llmDecisions,
    llm_avg_confidence: avgConf,
    llm_by_decision: byDecision,
    llm_by_mtf: byMtf,
    per_algo: perAlgo,
    notable_saves: notable,
  } = activity;

  console.log(`--- Engine activity (last ${ACTIVITY_DAYS}d) ---\n`);
  console.log(
    `LLM decisions: ${llmDecisions}${avgConf != null ? ` · avg confidence ${avgConf}` : ""}`
  );
  if (Object.keys(byDecision).length > 0) {
    const parts = Object.entries(byDecision)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}=${v}`)
      .join(" · ");
    console.log(`  ${parts}`);
  }
  if (Object.keys(byMtf).length > 0) {
    const parts = Object.entries(byMtf)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}=${v}`)
      .join(" · ");
    console.log(`  mtf: ${parts}`);
  }
  console.log("");
  console.log(
    `  ${pad("algo", 38)}${pad("evals", 7)}${pad("gate", 6)}${pad("cond", 6)}${pad("drift", 7)}${pad("stale", 7)}${pad("holds", 7)}${pad("other", 7)}fires`
  );
  for (const a of perAlgo) {
    console.log(
      `  ${pad(a.name, 38)}${pad(String(a.evaluations), 7)}${pad(String(a.gate_refusals), 6)}${pad(String(a.condition_misses), 6)}${pad(String(a.drift_refusals), 7)}${pad(String(a.bar_staleness_refusals), 7)}${pad(String(a.llm_holds), 7)}${pad(String(a.other_refusals), 7)}${a.fires}`
    );
  }
  if (notable.length > 0) {
    console.log("\nNotable saves (drift refusals — gate caught a stale-price entry):");
    for (const s of notable) {
      console.log(
        `  ${s.when.slice(0, 16)}Z  ${s.algorithm}  conf ${s.confidence ?? "?"}, ${s.would_have_entered_side ?? "?"}`
      );
      if (s.llm_reasoning) console.log(`    "${s.llm_reasoning.slice(0, 180)}"`);
    }
  }
  console.log("");

  return activity;
}

function formatBucket(b: CohortBucket): string {
  const wr = b.stats.n ? `${b.stats.win_rate_pct.toFixed(0)}%` : "-";
  const meanR = b.stats.n ? b.stats.mean_r.toFixed(2) : "-";
  return `${pad(b.stats.n.toString(), 5)}${pad(wr, 7)}${pad(meanR, 8)}${b.stats.sum_r.toFixed(1)}`;
}

function printDimensions(dimensions: CohortDimensionReport[]): void {
  console.log("--- All-time cohort expectancy ---");
  for (const dim of dimensions) {
    console.log(`\n${dim.label}:`);
    console.log(`  ${pad("value", 16)}${pad("n", 5)}${pad("WR", 7)}${pad("meanR", 8)}sumR`);
    for (const b of dim.buckets) {
      console.log(`  ${pad(b.value, 16)}${formatBucket(b)}`);
    }
  }
}

async function main(): Promise<void> {
  console.log(`\n===== Cohort report @ ${new Date().toISOString().slice(0, 16)} =====`);
  console.log(`source=${SOURCE} · decay halves=${DAYS}d · MIN_N=${MIN_N}\n`);

  // SG.6.1 (2026-06-22 NIGHT LATE): aggregation delegated to the shared lib.
  // The CLI keeps responsibility for: (a) console rendering of the
  // structured result, (b) the engine-activity section (already shared),
  // (c) writing dated JSON files for historical diff.
  const report = await buildCohortReport(supabase, { days: DAYS, source: SOURCE, minN: MIN_N });

  console.log(
    `${report.total_trades} completed entries with outcomes (${report.trades_skipped_no_r} skipped without r_multiple) · ` +
      `${report.trades_with_zone_tags} carry entry-zone tags\n`
  );

  const engineActivity = await printEngineActivity();

  if (report.total_trades === 0) {
    console.log("No closed trades in the cohort window yet — engine activity above is the");
    console.log("weekly read for now (expected during the 30-day observation between any");
    console.log("config change and the first closed trade).");
  } else {
    printDimensions(report.dimensions);

    // Decay flags
    console.log(`\n--- Decay flags (last ${DAYS}d vs prior ${DAYS}d, n≥${MIN_N} both halves) ---`);
    if (report.decay_flags.length === 0) {
      console.log("  none — or insufficient n on every cohort (expected while live-paper data accumulates)");
    } else {
      for (const f of report.decay_flags) {
        console.log(
          `  ⚠ ${f.dimension}=${f.value}: meanR ${f.prior_mean_r.toFixed(2)}→${f.recent_mean_r.toFixed(2)}, WR ${f.prior_wr_pct.toFixed(0)}%→${f.recent_wr_pct.toFixed(0)}% (n ${f.prior_n}→${f.recent_n})`
        );
      }
    }

    // Shadow-gate candidates
    console.log(`\n--- Shadow-gate candidates (all-time n≥8, meanR ≤ −0.3) ---`);
    if (report.shadow_gate_candidates.length === 0) {
      console.log("  none at current n — keep accumulating");
    } else {
      for (const c of report.shadow_gate_candidates) {
        console.log(`  → ${c.rationale}`);
      }
    }
  }

  const outPath = `scripts/cohort-report-${new Date().toISOString().slice(0, 10)}.json`;
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        // Schema: post-SG.6.1 mirrors `CohortReport` from
        // src/lib/cohort/cohort-report.ts — dimensions is now a typed
        // array of `CohortDimensionReport`, decay_flags is `DecayFlag[]`,
        // shadow_gate_candidates is `ShadowGateCandidate[]`. Pre-SG.6.1
        // dated files used Record<dim, Record<value, Agg>> + string[]
        // for flags/candidates; won't diff cleanly across the boundary.
        ...report,
        activity_days: ACTIVITY_DAYS,
        engine_activity: engineActivity,
      },
      null,
      2
    )
  );
  console.log(`\nSaved: ${outPath}`);
}

main().catch((err) => {
  console.error("cohort-report failed:", err);
  process.exit(1);
});
