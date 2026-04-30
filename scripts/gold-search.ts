/**
 * Gold combinatorial-search runner — restricts the search universe to
 * XAU/USD, ranks the gold + non-gold templates by walk-forward, and
 * runs the dual-run validator against each top candidate that uses a
 * gold-only primitive (gold_session_window / asian_range_break /
 * post_news_window). Ends by calibrating the #1 candidate's sizing to
 * the user's monthly target.
 *
 * Usage:
 *   pnpm tsx scripts/gold-search.ts
 *
 * Override defaults via env:
 *   CAPITAL=100000 TARGET=10 TOP_N=5 MAX_CANDIDATES=80 \
 *     pnpm tsx scripts/gold-search.ts
 *
 * What the dual-run reports tell you (per top candidate using a
 * gold-only primitive):
 *   - win_rate_of_windows_pp: positive = filter helps stability
 *   - mean_return_pp:         positive = filter helps return
 *   - mean_drawdown_pp:       negative = filter helps drawdown
 *   - std_return_pp:          negative = filter helps consistency
 *
 * If a candidate's edge_diff is roughly zero, the gold-only primitive
 * isn't carrying its weight on that template — the rule says drop it
 * (`feedback_data_driven_gates`).
 */
import { readFileSync } from "fs";
import { runCombinatorialSearch } from "../src/lib/algorithm/combinatorial-search";
import { calibrateRiskToTarget } from "../src/lib/algorithm/combinatorial-search/calibrate";
import { dualRunGoldFilter } from "../src/lib/algorithm/dual-run-validator";
import {
  defaultWalkForwardStepDays,
  defaultWalkForwardWindowDays,
  timeframeToInterval,
  type BarInterval,
} from "../src/lib/market-data/interval";
import { fetchDailyPrices } from "../src/lib/market-data/prices";
import type { PriceBar } from "../src/lib/market-data/types";
import { algorithmRulesSchema } from "../src/lib/validators/algorithm";
import type { CandidateResult } from "../src/lib/algorithm/combinatorial-search";

const GOLD_ONLY_PATTERNS = new Set([
  "gold_session_window",
  "asian_range_break",
  "post_news_window",
]);

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

let cachedCorpus: Map<string, Map<string, PriceBar[]>> | null = null;

async function loadCorpus(
  symbols: string[],
  timeframes: string[]
): Promise<Map<string, Map<string, PriceBar[]>>> {
  if (cachedCorpus) return cachedCorpus;

  const intervals = new Set<BarInterval>();
  const intervalByTf = new Map<string, BarInterval>();
  for (const tf of timeframes) {
    const iv = timeframeToInterval(tf);
    intervals.add(iv);
    intervalByTf.set(tf, iv);
  }
  const byInterval = new Map<BarInterval, Map<string, PriceBar[]>>();
  for (const iv of intervals) byInterval.set(iv, new Map());

  for (const iv of intervals) {
    for (const sym of symbols) {
      try {
        const bars = await fetchDailyPrices(sym, "full", iv);
        if (bars.length >= 100) byInterval.get(iv)!.set(sym, bars);
        console.log(`  ${sym} ${iv}: ${bars.length} bars`);
      } catch (err) {
        console.log(`  ${sym} ${iv}: FAIL (${(err as Error).message})`);
      }
    }
  }

  const out = new Map<string, Map<string, PriceBar[]>>();
  for (const [tf, iv] of intervalByTf) {
    const bars = byInterval.get(iv);
    if (bars) out.set(tf, bars);
  }
  cachedCorpus = out;
  return out;
}

function usesGoldOnlyPattern(candidate: CandidateResult): boolean {
  return candidate.rules.entry_conditions.some(
    (c) => c.type === "pattern" && GOLD_ONLY_PATTERNS.has(c.pattern)
  );
}

function printCandidate(candidate: CandidateResult, rank: number): void {
  console.log(
    `  #${rank}  ${candidate.label.padEnd(48)} ` +
      `score=${candidate.score.toFixed(2).padStart(7)}  ` +
      `monthly=${candidate.monthly_return_pct.toFixed(2).padStart(6)}%  ` +
      `worst_dd=${candidate.worst_dd_pct.toFixed(2).padStart(5)}%  ` +
      `green_windows=${(candidate.walk_forward.win_rate_of_windows * 100).toFixed(0)}%`
  );
}

async function runDualRunForCandidate(
  candidate: CandidateResult,
  corpus: Map<string, Map<string, PriceBar[]>>,
  capital: number,
  windowDaysOverride: number | undefined,
  stepDaysOverride: number | undefined
): Promise<void> {
  const tfPrices = corpus.get(candidate.rules.timeframe);
  if (!tfPrices || tfPrices.size === 0) {
    console.log(`    Dual-run skipped — no corpus for timeframe ${candidate.rules.timeframe}`);
    return;
  }
  // Match the search engine's per-candidate window scaling — same
  // candidate gets evaluated on the same window shape with vs without
  // the gold-only filter, otherwise the edge-diff comparison is apples
  // to oranges.
  const tf = candidate.rules.timeframe;
  const testWindowDays = windowDaysOverride ?? defaultWalkForwardWindowDays(tf);
  const stepDays = stepDaysOverride ?? defaultWalkForwardStepDays(tf);

  const result = dualRunGoldFilter(candidate.rules, tfPrices, capital, {
    testWindowDays,
    stepDays,
  });

  if (result.filters_stripped === 0) {
    console.log("    Dual-run skipped — candidate has no gold-only patterns");
    return;
  }

  const ed = result.edge_diff;
  console.log(
    `    Dual-run (${result.filters_stripped} gold-only condition(s) stripped):`
  );
  console.log(
    `      win_rate_of_windows_pp = ${ed.win_rate_of_windows_pp >= 0 ? "+" : ""}${ed.win_rate_of_windows_pp.toFixed(3)}  ` +
      `(positive = filter helps)`
  );
  console.log(
    `      mean_return_pp         = ${ed.mean_return_pp >= 0 ? "+" : ""}${ed.mean_return_pp.toFixed(2)}  ` +
      `(positive = filter helps)`
  );
  console.log(
    `      mean_drawdown_pp       = ${ed.mean_drawdown_pp >= 0 ? "+" : ""}${ed.mean_drawdown_pp.toFixed(2)}  ` +
      `(negative = filter helps)`
  );
  console.log(
    `      std_return_pp          = ${ed.std_return_pp >= 0 ? "+" : ""}${ed.std_return_pp.toFixed(2)}  ` +
      `(negative = filter helps)`
  );

  // Heuristic verdict — surface the simple "is this carrying weight?" answer.
  const helps =
    ed.mean_return_pp > 0 || ed.mean_drawdown_pp < 0 || ed.win_rate_of_windows_pp > 0;
  if (!helps) {
    console.log(
      "      VERDICT: filter not earning its keep on this template; consider dropping per feedback_data_driven_gates."
    );
  } else {
    console.log("      VERDICT: filter contributes measurable edge — carve-out justified.");
  }
}

async function main(): Promise<void> {
  const capital = Number(process.env.CAPITAL ?? "100000");
  const target = Number(process.env.TARGET ?? "10");
  const topN = Number(process.env.TOP_N ?? "5");
  const includeEvaluated =
    process.env.INCLUDE_EVALUATED === "true" || process.env.INCLUDE_EVALUATED === "1";
  const maxCandidates = Number(process.env.MAX_CANDIDATES ?? "80");
  const symbolsArg = process.env.SYMBOLS ?? "XAU/USD";
  const symbols = symbolsArg.split(",").map((s) => s.trim()).filter(Boolean);
  // Walk-forward window/step default to per-candidate scaling (15m
  // candidates get 30d windows, 1h gets 90d, 4h gets 180d, 1d gets
  // 365d). Set WALK_FORWARD_WINDOW_DAYS / WALK_FORWARD_STEP_DAYS env
  // vars to force a fixed window across all candidates (diagnostic).
  const windowDaysOverride = process.env.WALK_FORWARD_WINDOW_DAYS;
  const stepDaysOverride = process.env.WALK_FORWARD_STEP_DAYS;
  const windowDays = windowDaysOverride ? Number(windowDaysOverride) : undefined;
  const stepDays = stepDaysOverride ? Number(stepDaysOverride) : undefined;

  console.log("Gold combinatorial search runner");
  console.log(`  capital            : $${capital.toLocaleString()}`);
  console.log(`  monthly_target_pct : ${target}%`);
  console.log(`  symbols            : ${symbols.join(", ")}`);
  console.log(`  max_candidates     : ${maxCandidates}`);
  console.log(`  top_n              : ${topN}`);
  console.log(
    `  walk_forward       : ${
      windowDays !== undefined
        ? `${windowDays}d window (forced), ${stepDays ?? "default"}d step`
        : "per-timeframe defaults (15m=30d, 1h=90d, 4h=180d, 1d=365d)"
    }\n`
  );

  console.log("Fetching prices...");
  const start = Date.now();

  const result = await runCombinatorialSearch(
    {
      capital,
      monthly_target_pct: target,
      prefer_symbols: symbols,
    },
    loadCorpus,
    {
      max_candidates: maxCandidates,
      top_n: topN,
      include_evaluated: includeEvaluated,
      ...(windowDays !== undefined ? { walk_forward_window_days: windowDays } : {}),
      ...(stepDays !== undefined ? { walk_forward_step_days: stepDays } : {}),
    }
  );

  console.log(`\nSearch complete in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  console.log(`  evaluated : ${result.candidates_evaluated}`);
  console.log(`  passed    : ${result.candidates_passed}\n`);

  if (result.top.length === 0) {
    console.log("No top candidate. Try lowering target, broadening filters, or extending data range.");
    return;
  }

  console.log(`Top ${result.top.length} candidates (ranked by score):`);
  for (const c of result.top) printCandidate(c, c.rank);

  if (includeEvaluated && result.all_evaluated) {
    console.log(`\nFull ranking (all ${result.all_evaluated.length} evaluated, sorted by score):`);
    result.all_evaluated.forEach((c, i) => {
      const passMark =
        c.pass_criteria.walk_forward_green &&
        c.pass_criteria.target_met &&
        c.pass_criteria.dd_safe
          ? "PASS"
          : "FAIL";
      const failReasons: string[] = [];
      if (!c.pass_criteria.walk_forward_green) failReasons.push("wf-green");
      if (!c.pass_criteria.target_met) failReasons.push("target");
      if (!c.pass_criteria.dd_safe) failReasons.push("dd");
      const failTag = failReasons.length > 0 ? ` [${failReasons.join(",")}]` : "";
      console.log(
        `  #${String(i + 1).padStart(3)}  ${c.label.padEnd(48)} ` +
          `score=${c.score.toFixed(2).padStart(7)}  ` +
          `monthly=${c.monthly_return_pct.toFixed(2).padStart(6)}%  ` +
          `dd=${c.worst_dd_pct.toFixed(2).padStart(5)}%  ` +
          `${passMark}${failTag}`
      );
    });
  }

  console.log("\nDual-run validation (gold-only filter — earns its keep?):");
  if (!cachedCorpus) {
    console.log("  No cached corpus — dual-run requires the search corpus. Skipping.");
  } else {
    for (const c of result.top) {
      console.log(`\n  Candidate #${c.rank}: ${c.label}`);
      if (!usesGoldOnlyPattern(c)) {
        console.log("    No gold-only patterns — dual-run not applicable.");
        continue;
      }
      await runDualRunForCandidate(c, cachedCorpus, capital, windowDays, stepDays);
    }
  }

  // Calibrate #1 candidate.
  const picked = result.top[0];
  const calibration = calibrateRiskToTarget(picked.rules, picked.monthly_return_pct, target);

  console.log(`\nCalibration of #1 (${picked.label}):`);
  console.log(`  scaling_factor       : ${calibration.scaling_factor.toFixed(2)}x`);
  console.log(
    `  base risk            : ${calibration.original_value} → ${calibration.calibrated_value}`
  );
  console.log(`  capped               : ${calibration.capped ? "YES (FTMO-safe cap hit)" : "no"}`);
  console.log(`  estimated_monthly_pct: ${calibration.estimated_monthly_pct.toFixed(2)}%`);

  const parsed = algorithmRulesSchema.safeParse(calibration.rules);
  if (!parsed.success) {
    console.log(`\nFAIL: Calibrated rules failed Zod validation`);
    for (const issue of parsed.error.issues.slice(0, 5)) {
      console.log(`  ${issue.path.join(".")}: ${issue.message}`);
    }
    return;
  }
  console.log(`\nZod validation: rules ready to insert into algorithms table.`);

  const r = calibration.rules;
  console.log(`\nCalibrated rules summary:`);
  console.log(`  timeframe       : ${r.timeframe}`);
  console.log(`  asset_class     : ${r.asset_class}`);
  console.log(`  side            : ${r.side ?? "long"}`);
  console.log(`  entry_logic     : ${JSON.stringify(r.entry_logic)}`);
  console.log(`  entry conditions:`);
  for (const c of r.entry_conditions) {
    if (c.type === "pattern") {
      const session = "session" in c && c.session ? `  session=${c.session}` : "";
      console.log(
        `    [${c.timeframe}] pattern=${c.pattern}  dir=${c.direction ?? "any"}${session}`
      );
    } else if (c.type === "technical") {
      console.log(`    [${c.timeframe}] tech=${c.indicator} ${c.operator} ${c.value}`);
    }
  }
  console.log(`  stop_loss       : ${r.stop_loss.type} ${r.stop_loss.value}`);
  console.log(`  take_profit     : ${r.take_profit.type} ${r.take_profit.value}`);
  console.log(`  position_sizing : ${r.position_sizing.type} = ${r.position_sizing.value}`);
  console.log(`  max_positions   : ${r.max_positions}`);
  console.log(`  leverage        : ${r.leverage ?? "default"}`);

  console.log("\nDecision points for the operator:");
  console.log("  1. Does the dual-run verdict on this candidate's gold-only patterns justify keeping them?");
  console.log("  2. Is the calibrated risk (above) acceptable, or did the FTMO cap force a shortfall?");
  console.log("  3. Walk-forward green-window rate ≥ 60% considered robust; below that is fragile.");
  console.log("  4. Final step (manual): persist the calibrated rules via the algorithm-create flow,");
  console.log("     enable live_trading_enabled, point at the existing FTMO MetaApi broker_connection.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
