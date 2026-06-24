/**
 * F.6a — Walk-forward chronological vs purged k-fold equivalence test.
 *
 * F.3 trusts purged k-fold CV; F.4 walk-forward windowing also trusts
 * chronological splits. Both should produce CONVERGENT per-fold mean R
 * on the same trade set — if they diverge significantly, one of the
 * downstream gates is suspect.
 *
 * Method:
 *   1. Load v3 survivor (or any TARGET algo) from DB
 *   2. Run backtest once → trades + per-trade R
 *   3. Compute purged k-fold (existing purgedKFoldEvaluate, k=5)
 *   4. Compute chronological walk-forward (sorted-by-entry-date split
 *      into k equal-count windows; no purging — that's the whole point
 *      of the comparison)
 *   5. Compare per-fold mean R; report sign-agreement rate + max
 *      absolute delta
 *
 * Pre-registered gate:
 *   - sign-agreement ≥ 80% across folds, AND
 *   - max per-fold |delta| < 0.30R
 *
 * Compute: ~5s wall-clock (single backtest + pure analysis).
 *
 * Persists scripts/canonical/wf-vs-kfold-equivalence-results.json.
 *
 * Usage:
 *   pnpm dlx tsx scripts/canonical/wf-vs-kfold-equivalence.ts
 *
 * Env:
 *   TARGET_NAME         default "LayerB: XAU/USD Engulfing-Long 4h | rr3_lb6_r06_rf0_af0"
 *   K_FOLDS             default 5
 *   EMBARGO_FRACTION    default 0.01
 *   SIGN_AGREEMENT_GATE default 0.8 (80%)
 *   MAX_DELTA_GATE      default 0.3 (R)
 *   OUTPUT_JSON         default scripts/canonical/wf-vs-kfold-equivalence-results.json
 *   PERSIST             default 1
 */
import { readFileSync, writeFileSync } from "fs";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { timeframeToInterval } from "../../src/lib/market-data/interval";
import { runPortfolioBacktest } from "../../src/lib/market-data/portfolio-backtest";
import { purgedKFoldEvaluate } from "../../src/lib/stats/purged-kfold";
import type { Database } from "../../src/lib/supabase/database.types";
import type { BacktestTrade, PriceBar } from "../../src/lib/market-data/types";
import type { AlgorithmRules } from "../../src/types/algorithm";

// .env.local loader
{
  try {
    const raw = readFileSync(".env.local", "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (!m) continue;
      const [, k, v] = m;
      if (!process.env[k]) process.env[k] = v.replace(/^['"]|['"]$/g, "");
    }
  } catch {}
}

const TARGET_NAME =
  process.env.TARGET_NAME ??
  "LayerB: XAU/USD Engulfing-Long 4h | rr3_lb6_r06_rf0_af0";
const K_FOLDS = Math.max(2, Number(process.env.K_FOLDS ?? 5));
const EMBARGO_FRACTION = Number(process.env.EMBARGO_FRACTION ?? 0.01);
const SIGN_AGREEMENT_GATE = Number(process.env.SIGN_AGREEMENT_GATE ?? 0.8);
const MAX_DELTA_GATE = Number(process.env.MAX_DELTA_GATE ?? 0.3);
const OUTPUT_JSON =
  process.env.OUTPUT_JSON ?? "scripts/canonical/wf-vs-kfold-equivalence-results.json";
const PERSIST = process.env.PERSIST !== "0";

function requireEnv(): { url: string; key: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error(
      "wf-vs-kfold-equivalence requires NEXT_PUBLIC_SUPABASE_URL + " +
        "SUPABASE_SERVICE_ROLE_KEY (preferred) or NEXT_PUBLIC_SUPABASE_ANON_KEY in .env.local.",
    );
  }
  return { url, key };
}

function extractTicker(name: string): string {
  return name.replace(/^(Search|LayerB\+?):\s*/, "").split(" ")[0] ?? "XAU/USD";
}

function extractTimeframe(name: string): string {
  return name.match(/\s(\d+[mh])\s/)?.[1] ?? "4h";
}

function riskDollarsFor(rules: AlgorithmRules, capital: number): number {
  const sizing = rules.position_sizing;
  if (sizing?.type === "risk_per_trade") return capital * (sizing.value / 100);
  return capital * 0.01;
}

/** Chronological walk-forward by trade COUNT (not time-axis) — splits the
 *  sorted-by-entry-date trade list into k equal-count windows. Differs from
 *  purgedKFoldEvaluate's time-axis split: this one guarantees equal-N
 *  windows even when trades are clumped temporally. Returns per-fold mean R
 *  on the trades inside that window. No purging / no embargo by design —
 *  the F.6a question is "do purged-kfold and naive chronological agree?". */
function chronologicalWalkForward(
  trades: readonly BacktestTrade[],
  k: number,
  riskDollars: number,
): Array<{ fold_index: number; test_n: number; test_mean_r: number; window_start: string; window_end: string }> {
  if (trades.length === 0) return [];
  const sorted = [...trades].sort(
    (a, b) => new Date(a.entry_date).getTime() - new Date(b.entry_date).getTime(),
  );
  const out: Array<{ fold_index: number; test_n: number; test_mean_r: number; window_start: string; window_end: string }> = [];
  const baseFoldSize = Math.floor(sorted.length / k);
  let cursor = 0;
  for (let i = 0; i < k; i++) {
    const start = cursor;
    // Last fold absorbs any remainder.
    const end = i === k - 1 ? sorted.length : cursor + baseFoldSize;
    const fold = sorted.slice(start, end);
    const meanR =
      fold.length > 0 && riskDollars > 0
        ? fold.reduce((acc, t) => acc + t.pnl / riskDollars, 0) / fold.length
        : 0;
    out.push({
      fold_index: i,
      test_n: fold.length,
      test_mean_r: meanR,
      window_start: fold[0]?.entry_date ?? "",
      window_end: fold[fold.length - 1]?.entry_date ?? "",
    });
    cursor = end;
  }
  return out;
}

async function loadBars(
  supabase: SupabaseClient<Database>,
  ticker: string,
  timeframe: string,
): Promise<PriceBar[]> {
  const interval = timeframeToInterval(timeframe);
  const { data, error } = await supabase
    .from("price_cache")
    .select("bars")
    .eq("ticker", ticker.toUpperCase())
    .eq("output_size", "full")
    .eq("interval", interval)
    .limit(1)
    .single();
  if (error || !data) {
    throw new Error(`No cached bars for ${ticker} ${interval}: ${error?.message ?? "row missing"}`);
  }
  return data.bars as unknown as PriceBar[];
}

async function main(): Promise<void> {
  const { url, key } = requireEnv();
  const supabase = createClient<Database>(url, key);

  console.log(`F.6a wf-vs-kfold equivalence test`);
  console.log(`  target : ${TARGET_NAME}`);
  console.log(`  k : ${K_FOLDS}, embargo_fraction : ${EMBARGO_FRACTION}`);
  console.log(`  sign-agreement gate : ≥${(SIGN_AGREEMENT_GATE * 100).toFixed(0)}%`);
  console.log(`  max-delta gate : <${MAX_DELTA_GATE.toFixed(2)} R`);
  console.log("");

  const { data: row, error } = await supabase
    .from("algorithms")
    .select("id, name, rules, capital")
    .eq("name", TARGET_NAME)
    .maybeSingle();
  if (error) throw new Error(`Failed to fetch target ${TARGET_NAME}: ${error.message}`);
  if (!row) throw new Error(`No row for target ${TARGET_NAME}`);

  const ticker = extractTicker(row.name);
  const timeframe = extractTimeframe(row.name);
  console.log(`Loading bars for ${ticker} ${timeframe}...`);
  const bars = await loadBars(supabase, ticker, timeframe);
  const pricesByTicker = new Map<string, PriceBar[]>([[ticker.toUpperCase(), bars]]);

  console.log("Running single backtest on target...");
  const rules = row.rules as unknown as AlgorithmRules;
  const capital = Number(row.capital);
  const result = runPortfolioBacktest(rules, pricesByTicker, capital);
  const trades = result.trades ?? [];
  const riskDollars = riskDollarsFor(rules, capital);
  console.log(`  trades : ${trades.length}, risk_dollars : $${riskDollars.toFixed(2)}`);

  if (trades.length < K_FOLDS) {
    throw new Error(
      `Only ${trades.length} trades; need ≥${K_FOLDS} for k-fold + WF comparison`,
    );
  }

  console.log("Computing purged k-fold...");
  const kfoldResult = purgedKFoldEvaluate(trades, riskDollars, {
    k: K_FOLDS,
    embargoFraction: EMBARGO_FRACTION,
  });

  console.log("Computing chronological walk-forward...");
  const wfResult = chronologicalWalkForward(trades, K_FOLDS, riskDollars);

  // Compare per-fold mean R, sign-agreement, max delta.
  // CRITICAL CAVEAT: purgedKFoldEvaluate splits the TIME AXIS into k equal
  // durations; chronologicalWalkForward splits the TRADE COUNT into k equal
  // bins. These produce different fold boundaries when trades are clumped
  // temporally — so per-fold-index comparison is approximate. We report
  // BOTH per-fold-index delta AND aggregate-stats delta (mean R + consistency).
  const perFoldComparison = [];
  for (let i = 0; i < K_FOLDS; i++) {
    const kf = kfoldResult.folds[i];
    const wf = wfResult[i];
    if (!kf || !wf) continue;
    const delta = wf.test_mean_r - kf.test_mean_r;
    const signKf = Math.sign(kf.test_mean_r);
    const signWf = Math.sign(wf.test_mean_r);
    const signAgrees = signKf === signWf || signKf === 0 || signWf === 0;
    perFoldComparison.push({
      fold_index: i,
      kfold_test_mean_r: kf.test_mean_r,
      kfold_test_n: kf.test_n,
      wf_test_mean_r: wf.test_mean_r,
      wf_test_n: wf.test_n,
      delta_r: delta,
      sign_agrees: signAgrees,
    });
  }

  const signAgreementRate =
    perFoldComparison.length > 0
      ? perFoldComparison.filter((c) => c.sign_agrees).length / perFoldComparison.length
      : 0;
  const maxAbsDelta = perFoldComparison.reduce((acc, c) => Math.max(acc, Math.abs(c.delta_r)), 0);

  // Aggregate-level delta (more robust when fold boundaries differ).
  const kfoldAggregate = kfoldResult.oos_mean_r_aggregate;
  const wfAggregate =
    wfResult.length > 0 ? wfResult.reduce((acc, w) => acc + w.test_mean_r, 0) / wfResult.length : 0;
  const aggregateDelta = wfAggregate - kfoldAggregate;
  const kfoldConsistency = kfoldResult.consistency_count;
  const wfConsistency = wfResult.filter((w) => w.test_mean_r > 0).length;

  const signGatePassed = signAgreementRate >= SIGN_AGREEMENT_GATE;
  const deltaGatePassed = maxAbsDelta < MAX_DELTA_GATE;
  const verdict: "PASS" | "FAIL" = signGatePassed && deltaGatePassed ? "PASS" : "FAIL";

  console.log("");
  console.log(`F.6a WF-VS-KFOLD VERDICT: ${verdict}`);
  console.log(`  sign-agreement rate : ${(signAgreementRate * 100).toFixed(1)}% (gate ≥${(SIGN_AGREEMENT_GATE * 100).toFixed(0)}%) ${signGatePassed ? "✓" : "✗"}`);
  console.log(`  max |per-fold delta R| : ${maxAbsDelta.toFixed(4)} (gate <${MAX_DELTA_GATE.toFixed(2)}) ${deltaGatePassed ? "✓" : "✗"}`);
  console.log(`  kfold aggregate mean R : ${kfoldAggregate.toFixed(4)} (consistency ${kfoldConsistency}/${K_FOLDS})`);
  console.log(`  WF aggregate mean R    : ${wfAggregate.toFixed(4)} (consistency ${wfConsistency}/${K_FOLDS})`);
  console.log(`  aggregate delta : ${aggregateDelta.toFixed(4)}`);
  console.log("");
  console.log("Per-fold comparison:");
  for (const c of perFoldComparison) {
    const marker = c.sign_agrees ? "✓" : "✗";
    console.log(
      `  fold ${c.fold_index} ${marker} | kfold n=${c.kfold_test_n} r=${c.kfold_test_mean_r.toFixed(4)} | wf n=${c.wf_test_n} r=${c.wf_test_mean_r.toFixed(4)} | delta=${c.delta_r.toFixed(4)}`,
    );
  }

  const output = {
    sub_gate: "F.6a wf-vs-kfold" as const,
    verdict,
    sign_agreement_rate: signAgreementRate,
    sign_agreement_gate: SIGN_AGREEMENT_GATE,
    sign_gate_passed: signGatePassed,
    max_abs_delta_r: maxAbsDelta,
    max_delta_gate: MAX_DELTA_GATE,
    delta_gate_passed: deltaGatePassed,
    aggregate_delta: aggregateDelta,
    kfold_aggregate_mean_r: kfoldAggregate,
    wf_aggregate_mean_r: wfAggregate,
    kfold_consistency_count: kfoldConsistency,
    wf_consistency_count: wfConsistency,
    k_folds: K_FOLDS,
    embargo_fraction: EMBARGO_FRACTION,
    target_name: TARGET_NAME,
    trade_count: trades.length,
    risk_dollars: riskDollars,
    per_fold_comparison: perFoldComparison,
    notes: [
      "purgedKFoldEvaluate splits TIME AXIS into k equal-duration folds; chronologicalWalkForward splits TRADE COUNT into k equal bins.",
      "Per-fold index comparison is approximate when trades clump temporally — use aggregate delta for primary signal.",
      "Sign agreement = both folds positive or both folds negative (zero counts as agreement to avoid false-fail on empty folds).",
    ],
    generated_at: new Date().toISOString(),
  };

  if (PERSIST) {
    writeFileSync(OUTPUT_JSON, JSON.stringify(output, null, 2));
    console.log("");
    console.log(`Persisted ${OUTPUT_JSON}`);
  } else {
    console.log("");
    console.log("(PERSIST=0 — verdict only, no file written)");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
