/**
 * H.4a — Label re-engineering driver. Iterates through 6 alternative
 * label functions and reports holdout AUC per variant against the same
 * 48-feature library that H.3 evaluated on the baseline (next-bar-sign)
 * label.
 *
 * Why this exists: H.3-execution returned AUC 0.5378 — 0.012 short of
 * the 0.55 floor. The H.3 honest-reading concluded the LABEL was the
 * binding constraint, not the feature set. H.4a tests that hypothesis
 * empirically.
 *
 * Variants iterated (locked in code; see src/lib/features/labels.ts):
 *   1. next_bar_sign                 (H.3 baseline; re-run for comparison)
 *   2. next_4_bar_sign               (4-bar horizon)
 *   3. next_24_bar_sign              (24-bar horizon)
 *   4. r_aware                       (TP-before-SL given algo's geometry)
 *   5. regime_conditioned            (sign within medium_vol regime)
 *   6. r_aware_regime_conditioned    (composite of 4 + 5)
 *
 * Gate (per ROADMAP H.4a): best variant achieves holdout AUC ≥ 0.55.
 *   PASS → persist winning label + top-K features to
 *          scripts/canonical/feature-importance-results.json (overwrites
 *          H.3's file; H.4b consumes the same path).
 *   FAIL → no overwrite; print "all 6 variants below 0.55" + file
 *          deferred-by-trigger guidance per roadmap H.4a failure branch.
 *
 * Usage:
 *   pnpm dlx tsx scripts/canonical/label-reengineering.ts
 *   ALGO_ID=<uuid> HOLDOUT_DAYS=365 TOP_K=10 pnpm dlx tsx scripts/canonical/label-reengineering.ts
 *
 * Wall-clock: ~6 variants × ~5-10s per xgboost run = ~1min total.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { platform } from "node:os";
import { resolve } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  buildTrainingRowsWithIdx,
  findHoldoutCutoffByDates,
  type TrainingRow,
} from "../../src/lib/features/training-rows";
import { FEATURES, type FeatureContext } from "../../src/lib/features";
import { LABEL_FN_NAMES, resolveLabelFn, type LabelFnName } from "../../src/lib/features/labels";
import { resampleToDaily } from "../../src/lib/market-data/resample";
import type { Database } from "../../src/lib/supabase/database.types";
import type { PriceBar } from "../../src/lib/market-data/types";
import type { AlgorithmRules } from "../../src/types/algorithm";

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

const ALGO_ID = process.env.ALGO_ID ?? "33b705b9-7442-4c73-8d97-4a88ecacb9a1";
const HOLDOUT_DAYS = Number(process.env.HOLDOUT_DAYS ?? "365");
const TOP_K = Number(process.env.TOP_K ?? "10");
const AUC_GATE = Number(process.env.AUC_GATE ?? "0.55");
const VENV_PYTHON = resolve(process.cwd(), "scripts/python/.venv/bin/python3");
const PYTHON_BIN = process.env.PYTHON_BIN ?? (existsSync(VENV_PYTHON) ? VENV_PYTHON : "python3");
const PYTHON_SCRIPT = resolve(process.cwd(), "scripts/python/feature_importance.py");
const RESULTS_FILE = resolve(process.cwd(), "scripts/canonical/feature-importance-results.json");
const H4A_RESULTS_FILE = resolve(process.cwd(), "scripts/canonical/label-reengineering-results.json");
const PERSIST = process.env.PERSIST !== "0";

function macLibompEnv(): Record<string, string> {
  if (platform() !== "darwin") return {};
  for (const prefix of [
    "/Users/jack.jones/.homebrew/opt/libomp/lib",
    "/opt/homebrew/opt/libomp/lib",
    "/usr/local/opt/libomp/lib",
  ]) {
    if (existsSync(`${prefix}/libomp.dylib`)) {
      const current = process.env.DYLD_LIBRARY_PATH ?? "";
      return { DYLD_LIBRARY_PATH: current ? `${prefix}:${current}` : prefix };
    }
  }
  return {};
}

function fail(msg: string): never {
  console.error(`[label-reengineering] ${msg}`);
  process.exit(1);
}

interface PythonResult {
  auc_train: number;
  auc_holdout: number;
  n_train: number;
  n_holdout: number;
  feature_importance: { name: string; gain: number }[];
  label_balance_train: { pos: number; neg: number };
  label_balance_holdout: { pos: number; neg: number };
}

function runPythonSidecar(payload: {
  feature_names: string[];
  rows: TrainingRow[];
  holdout_cutoff_idx: number;
}): Promise<PythonResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const proc = spawn(PYTHON_BIN, [PYTHON_SCRIPT], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...macLibompEnv() },
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("error", (err) =>
      rejectPromise(
        new Error(`failed to spawn ${PYTHON_BIN}: ${err.message}. Set PYTHON_BIN env if python3 isn't on PATH.`),
      ),
    );
    proc.on("close", (code) => {
      if (code !== 0) {
        rejectPromise(new Error(`Python sidecar exited ${code}. stderr: ${stderr.trim()}`));
        return;
      }
      try {
        resolvePromise(JSON.parse(stdout) as PythonResult);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        rejectPromise(new Error(`Failed to parse Python stdout as JSON: ${msg}\nstdout: ${stdout.slice(0, 500)}`));
      }
    });
    proc.stdin.write(JSON.stringify(payload));
    proc.stdin.end();
  });
}

async function loadAlgoBars(
  supabase: SupabaseClient<Database>,
): Promise<{ ticker: string; timeframe: string; bars: PriceBar[]; rules: AlgorithmRules }> {
  const { data: algoRow, error: algoErr } = await supabase
    .from("algorithms")
    .select("id, name, rules, algorithm_watchlist(ticker)")
    .eq("id", ALGO_ID)
    .single();
  if (algoErr || !algoRow) fail(`algo fetch failed: ${algoErr?.message ?? "no row"}`);
  const rules = algoRow.rules as unknown as AlgorithmRules;
  const watchlist = (algoRow.algorithm_watchlist ?? []) as { ticker: string }[];
  if (watchlist.length === 0) fail(`algo ${ALGO_ID} has no watchlist tickers`);
  const ticker = watchlist[0].ticker;
  const timeframe = rules.timeframe;
  console.log(`[label-reengineering] Loading bars for ${ticker} ${timeframe} ...`);
  const { data, error } = await supabase
    .from("price_cache")
    .select("bars")
    .eq("ticker", ticker.toUpperCase())
    .eq("output_size", "full")
    .eq("interval", timeframe)
    .limit(1)
    .single();
  if (error || !data) fail(`no cached bars for ${ticker} ${timeframe}: ${error?.message ?? "row missing"}`);
  const bars = data.bars as unknown as PriceBar[];
  console.log(`  ${bars.length} bars (${bars[0]?.date} → ${bars[bars.length - 1]?.date})`);
  return { ticker, timeframe, bars, rules };
}

interface LabelVariantResult {
  label_fn: LabelFnName;
  auc_train: number | null;
  auc_holdout: number | null;
  n_train: number;
  n_holdout: number;
  label_balance_train: { pos: number; neg: number };
  label_balance_holdout: { pos: number; neg: number };
  top_features: { name: string; gain: number }[];
  error: string | null;
  passes_gate: boolean;
}

async function main(): Promise<void> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? fail("NEXT_PUBLIC_SUPABASE_URL not set");
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? fail("SUPABASE_SERVICE_ROLE_KEY not set");
  const supabase: SupabaseClient<Database> = createClient(supabaseUrl, serviceKey);

  const { ticker, timeframe, bars, rules } = await loadAlgoBars(supabase);

  console.log(`\n[label-reengineering] H.4a — iterating ${LABEL_FN_NAMES.length} label variants × ${FEATURES.length} features`);
  console.log(`  algo: ${ALGO_ID}`);
  console.log(`  gate: holdout AUC ≥ ${AUC_GATE.toFixed(3)}`);
  console.log(`  holdout days: ${HOLDOUT_DAYS}`);

  const higherTfBars = resampleToDaily(bars);
  const ctx: FeatureContext = { higherTfBars };

  const variantResults: LabelVariantResult[] = [];

  for (const labelName of LABEL_FN_NAMES) {
    console.log(`\n  ── variant: ${labelName} ──`);
    let labelFn;
    try {
      labelFn = resolveLabelFn(labelName, { rules });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`    skipped: ${msg}`);
      variantResults.push({
        label_fn: labelName,
        auc_train: null,
        auc_holdout: null,
        n_train: 0,
        n_holdout: 0,
        label_balance_train: { pos: 0, neg: 0 },
        label_balance_holdout: { pos: 0, neg: 0 },
        top_features: [],
        error: msg,
        passes_gate: false,
      });
      continue;
    }

    const { rows, firstValidIdx, bar_indices } = buildTrainingRowsWithIdx(bars, ctx, labelFn);
    console.log(`    rows: ${rows.length} (first valid idx: ${firstValidIdx})`);

    if (rows.length < 200) {
      console.log(`    skipped: insufficient rows (need ≥200 for split; got ${rows.length})`);
      variantResults.push({
        label_fn: labelName,
        auc_train: null,
        auc_holdout: null,
        n_train: 0,
        n_holdout: 0,
        label_balance_train: { pos: 0, neg: 0 },
        label_balance_holdout: { pos: 0, neg: 0 },
        top_features: [],
        error: `insufficient rows: ${rows.length}`,
        passes_gate: false,
      });
      continue;
    }

    // Date-aware cutoff: required for label-fns that drop bars (regime-
    // conditioned, r_aware). Original findHoldoutCutoff assumed 1:1 row:bar
    // mapping which broke when ~70% of bars produced null labels.
    const cutoff = findHoldoutCutoffByDates(bars, bar_indices, HOLDOUT_DAYS);
    if (cutoff < 100 || rows.length - cutoff < 50) {
      console.log(`    skipped: insufficient split (train=${cutoff}, holdout=${rows.length - cutoff})`);
      variantResults.push({
        label_fn: labelName,
        auc_train: null,
        auc_holdout: null,
        n_train: cutoff,
        n_holdout: rows.length - cutoff,
        label_balance_train: { pos: 0, neg: 0 },
        label_balance_holdout: { pos: 0, neg: 0 },
        top_features: [],
        error: `insufficient split (train=${cutoff}, holdout=${rows.length - cutoff})`,
        passes_gate: false,
      });
      continue;
    }

    try {
      const result = await runPythonSidecar({
        feature_names: FEATURES.map((f) => f.name),
        rows,
        holdout_cutoff_idx: cutoff,
      });
      const passes = result.auc_holdout >= AUC_GATE;
      console.log(
        `    AUC(train)=${result.auc_train.toFixed(4)}  AUC(holdout)=${result.auc_holdout.toFixed(4)}  ${passes ? "✓" : "✗"}`,
      );
      console.log(
        `    label balance: train pos=${result.label_balance_train.pos} neg=${result.label_balance_train.neg} | holdout pos=${result.label_balance_holdout.pos} neg=${result.label_balance_holdout.neg}`,
      );
      variantResults.push({
        label_fn: labelName,
        auc_train: result.auc_train,
        auc_holdout: result.auc_holdout,
        n_train: result.n_train,
        n_holdout: result.n_holdout,
        label_balance_train: result.label_balance_train,
        label_balance_holdout: result.label_balance_holdout,
        top_features: result.feature_importance.slice(0, TOP_K),
        error: null,
        passes_gate: passes,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`    error: ${msg}`);
      variantResults.push({
        label_fn: labelName,
        auc_train: null,
        auc_holdout: null,
        n_train: cutoff,
        n_holdout: rows.length - cutoff,
        label_balance_train: { pos: 0, neg: 0 },
        label_balance_holdout: { pos: 0, neg: 0 },
        top_features: [],
        error: msg,
        passes_gate: false,
      });
    }
  }

  console.log("\n┌──────────────────────────────────────────────────────────────────────┐");
  console.log("│ H.4a verdict                                                         │");
  console.log("└──────────────────────────────────────────────────────────────────────┘");
  const ranked = [...variantResults].sort(
    (a, b) => (b.auc_holdout ?? -1) - (a.auc_holdout ?? -1),
  );
  for (const v of ranked) {
    const auc = v.auc_holdout !== null ? v.auc_holdout.toFixed(4) : "—";
    const status = v.error ? `error: ${v.error.slice(0, 40)}` : v.passes_gate ? "✓ PASS" : "✗ FAIL";
    console.log(`  ${v.label_fn.padEnd(30)} AUC ${auc.padStart(8)}  ${status}`);
  }
  console.log("");
  const best = ranked.find((v) => v.auc_holdout !== null) ?? null;
  const overallPasses = best !== null && best.auc_holdout !== null && best.auc_holdout >= AUC_GATE;
  console.log(
    `  best variant: ${best?.label_fn ?? "—"}  AUC ${best?.auc_holdout?.toFixed(4) ?? "—"}`,
  );
  console.log(`  H.4a gate (best ≥ ${AUC_GATE}): ${overallPasses ? "PASS" : "FAIL"}`);

  if (overallPasses && best) {
    if (PERSIST) {
      const persistPayload = {
        generated_for_algo_id: ALGO_ID,
        ticker,
        timeframe,
        holdout_days: HOLDOUT_DAYS,
        top_k: TOP_K,
        winning_label_fn: best.label_fn,
        auc_train: best.auc_train,
        auc_holdout: best.auc_holdout,
        passed_h3_gate: true,
        passed_h4a_gate: true,
        n_train: best.n_train,
        n_holdout: best.n_holdout,
        top_features: best.top_features,
        all_features: best.top_features,
        h4a_lineage: "H.4a winning variant overwrote H.3 baseline (next_bar_sign).",
      };
      writeFileSync(RESULTS_FILE, JSON.stringify(persistPayload, null, 2));
      console.log(`  persisted: ${RESULTS_FILE} (H.4b consumes this)`);
    } else {
      console.log(`  (PERSIST=0 — winning variant detected but H.3 results file untouched)`);
    }
  } else {
    console.log("");
    console.log("  All variants below the 0.55 floor. Per roadmap H.4a failure branch,");
    console.log("  file as deferred-by-trigger waiting on one of:");
    console.log("    (a) H.0 longer price history giving more training rows,");
    console.log("    (b) 15m timeframe giving more next-bar signal,");
    console.log("    (c) cross-asset features (positioning already infra-shipped per H.1).");
    console.log("  H.4b proceeds against the BEST available label rather than null.");
  }

  if (PERSIST) {
    const h4aPayload = {
      generated_at: new Date().toISOString(),
      algo_id: ALGO_ID,
      ticker,
      timeframe,
      auc_gate: AUC_GATE,
      holdout_days: HOLDOUT_DAYS,
      overall_passes: overallPasses,
      best_variant: best
        ? { label_fn: best.label_fn, auc_holdout: best.auc_holdout }
        : null,
      variants: variantResults,
    };
    writeFileSync(H4A_RESULTS_FILE, JSON.stringify(h4aPayload, null, 2));
    console.log(`  persisted full H.4a variants: ${H4A_RESULTS_FILE}`);
  }
}

main().catch((err) => {
  console.error("[label-reengineering] unhandled error:", err);
  process.exit(1);
});
