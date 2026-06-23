/**
 * H.3 — Feature importance driver. Builds training rows over an algo's
 * cached bars, invokes the Python xgboost sidecar via subprocess,
 * prints AUC + top-K feature importance, and persists results to
 * `scripts/canonical/feature-importance-results.json` for H.4 to consume.
 *
 * Usage:
 *   ALGO_ID=<uuid> [HOLDOUT_DAYS=365] [TOP_K=10] \
 *     pnpm dlx tsx scripts/canonical/feature-importance.ts
 *
 * Defaults run against the Engulfing rr3_lb6_r06 v3 survivor with
 * a 365-day chronological held-out window (matches the in-sample/OOS
 * convention in feedback_oos_cutoff_sweet_spot).
 *
 * Label: sign of next-bar return.
 *   1 = next close > current close
 *   0 = next close <= current close
 *
 * Held-out split: chronological (NEVER random for time series). Last
 * HOLDOUT_DAYS of bars are held out.
 *
 * Python deps required: see scripts/python/requirements.txt.
 *   pip install --user -r scripts/python/requirements.txt
 *
 * Gate (per ROADMAP H.3): held-out AUC > 0.55 + top-10 features
 * identified. AUC printed to stdout + verdict line:
 *   "H.3 gate verdict: PASS (AUC X > 0.55)" / "FAIL (AUC X ≤ 0.55)"
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { platform } from "node:os";
import { resolve } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { FEATURES, type FeatureContext } from "../../src/lib/features";
import { buildTrainingRows, findHoldoutCutoff, type TrainingRow } from "../../src/lib/features/training-rows";
import { resampleToDaily } from "../../src/lib/market-data/resample";
import type { Database } from "../../src/lib/supabase/database.types";
import type { PriceBar } from "../../src/lib/market-data/types";

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

const ALGO_ID = process.env.ALGO_ID ?? "33b705b9-7442-4c73-8d97-4a88ecacb9a1"; // Engulfing rr3_lb6_r06
const HOLDOUT_DAYS = Number(process.env.HOLDOUT_DAYS ?? "365");
const TOP_K = Number(process.env.TOP_K ?? "10");
// Auto-detect the venv python if present; falls back to system python3.
// Operator can override via PYTHON_BIN env var (e.g. for a different venv path).
const VENV_PYTHON = resolve(process.cwd(), "scripts/python/.venv/bin/python3");
const PYTHON_BIN = process.env.PYTHON_BIN ?? (existsSync(VENV_PYTHON) ? VENV_PYTHON : "python3");
const PYTHON_SCRIPT = resolve(process.cwd(), "scripts/python/feature_importance.py");
const RESULTS_FILE = resolve(process.cwd(), "scripts/canonical/feature-importance-results.json");

/** On macOS, homebrew installs libomp as keg-only — xgboost can't find
 *  it on its default search path. Detect a homebrew libomp install
 *  and add it to DYLD_LIBRARY_PATH for the spawned Python process
 *  (process-scoped; no global state change). Falls through silently
 *  on Linux + when libomp isn't present (caller's xgboost will surface
 *  the missing-lib error with its own install hint). */
function macLibompEnv(): Record<string, string> {
  if (platform() !== "darwin") return {};
  for (const prefix of ["/Users/jack.jones/.homebrew/opt/libomp/lib", "/opt/homebrew/opt/libomp/lib", "/usr/local/opt/libomp/lib"]) {
    if (existsSync(`${prefix}/libomp.dylib`)) {
      const current = process.env.DYLD_LIBRARY_PATH ?? "";
      return { DYLD_LIBRARY_PATH: current ? `${prefix}:${current}` : prefix };
    }
  }
  return {};
}

function fail(msg: string): never {
  console.error(`[feature-importance] ${msg}`);
  process.exit(1);
}

async function loadAlgoBars(supabase: SupabaseClient<Database>): Promise<{ ticker: string; timeframe: string; bars: PriceBar[] }> {
  const { data: algoRow, error: algoErr } = await supabase
    .from("algorithms")
    .select("id, name, rules, algorithm_watchlist(ticker)")
    .eq("id", ALGO_ID)
    .single();
  if (algoErr || !algoRow) fail(`algo fetch failed: ${algoErr?.message ?? "no row"}`);
  const rules = algoRow.rules as unknown as { timeframe: string };
  const watchlist = (algoRow.algorithm_watchlist ?? []) as { ticker: string }[];
  if (watchlist.length === 0) fail(`algo ${ALGO_ID} has no watchlist tickers`);
  const ticker = watchlist[0].ticker;
  const timeframe = rules.timeframe;
  console.log(`[feature-importance] Loading bars for ${ticker} ${timeframe} ...`);
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
  return { ticker, timeframe, bars };
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

function runPythonSidecar(payload: { feature_names: string[]; rows: TrainingRow[]; holdout_cutoff_idx: number }): Promise<PythonResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const proc = spawn(PYTHON_BIN, [PYTHON_SCRIPT], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...macLibompEnv() },
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("error", (err) => rejectPromise(new Error(`failed to spawn ${PYTHON_BIN}: ${err.message}. Set PYTHON_BIN env if python3 isn't on PATH.`)));
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

async function main(): Promise<void> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? fail("NEXT_PUBLIC_SUPABASE_URL not set");
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? fail("SUPABASE_SERVICE_ROLE_KEY not set");
  const supabase: SupabaseClient<Database> = createClient(supabaseUrl, serviceKey);

  const { ticker, timeframe, bars } = await loadAlgoBars(supabase);

  console.log(`[feature-importance] Building training rows over ${bars.length} bars × ${FEATURES.length} features ...`);
  const higherTfBars = resampleToDaily(bars);
  const ctx: FeatureContext = { higherTfBars };
  const { rows, firstValidIdx } = buildTrainingRows(bars, ctx);
  console.log(`  ${rows.length} rows (first valid bar idx: ${firstValidIdx})`);

  const cutoff = findHoldoutCutoff(bars, firstValidIdx, HOLDOUT_DAYS);
  console.log(`  chronological holdout cutoff: row ${cutoff} (train=${cutoff}, holdout=${rows.length - cutoff})`);

  if (cutoff < 100 || rows.length - cutoff < 50) {
    fail(`insufficient split sizes (train=${cutoff}, holdout=${rows.length - cutoff}). Increase HOLDOUT_DAYS or refresh price_cache.`);
  }

  console.log(`[feature-importance] Invoking Python sidecar (${PYTHON_BIN}) ...`);
  let result: PythonResult;
  try {
    result = await runPythonSidecar({
      feature_names: FEATURES.map((f) => f.name),
      rows,
      holdout_cutoff_idx: cutoff,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    fail(`${msg}\n\nIf this is the first run, install Python deps:\n  pip install --user -r scripts/python/requirements.txt`);
  }

  // Report
  console.log("\n┌──────────────────────────────────────────────────────────────────────┐");
  console.log("│ H.3 feature importance result                                        │");
  console.log("└──────────────────────────────────────────────────────────────────────┘");
  console.log(`  algo:          ${ALGO_ID}`);
  console.log(`  ticker / TF:   ${ticker} / ${timeframe}`);
  console.log(`  rows:          train=${result.n_train} (pos=${result.label_balance_train.pos}, neg=${result.label_balance_train.neg})`);
  console.log(`                 holdout=${result.n_holdout} (pos=${result.label_balance_holdout.pos}, neg=${result.label_balance_holdout.neg})`);
  console.log(`  AUC (train):   ${result.auc_train.toFixed(4)}`);
  console.log(`  AUC (holdout): ${result.auc_holdout.toFixed(4)}`);
  console.log(`\n  Top ${TOP_K} features by gain:`);
  for (const f of result.feature_importance.slice(0, TOP_K)) {
    console.log(`    ${f.name.padEnd(40)}  gain=${f.gain.toFixed(4)}`);
  }

  // H.3 gate
  console.log("\n┌──────────────────────────────────────────────────────────────────────┐");
  console.log("│ H.3 gate verdict                                                     │");
  console.log("└──────────────────────────────────────────────────────────────────────┘");
  const passed = result.auc_holdout > 0.55;
  console.log(`  ${passed ? "PASS" : "FAIL"} — held-out AUC ${result.auc_holdout.toFixed(4)} ${passed ? ">" : "≤"} 0.55`);
  console.log(`  top-${TOP_K} features identified: ${result.feature_importance.slice(0, TOP_K).length}`);
  if (!passed) {
    console.log("\n  Per the gate, if FAIL: features don't carry net predictive signal at 4h cadence");
    console.log("  for next-bar-direction. H.4 should NOT compose top features as Layer B axes");
    console.log("  without re-evaluating the labelling (e.g. multi-bar lookahead, R-aware label).");
  }

  // Persist for H.4 consumption (top-K list + AUC + metadata)
  const persistPayload = {
    generated_for_algo_id: ALGO_ID,
    ticker,
    timeframe,
    holdout_days: HOLDOUT_DAYS,
    top_k: TOP_K,
    auc_train: result.auc_train,
    auc_holdout: result.auc_holdout,
    passed_h3_gate: passed,
    n_train: result.n_train,
    n_holdout: result.n_holdout,
    top_features: result.feature_importance.slice(0, TOP_K),
    all_features: result.feature_importance,
  };
  writeFileSync(RESULTS_FILE, JSON.stringify(persistPayload, null, 2));
  console.log(`\n  persisted: ${RESULTS_FILE}`);
}

main().catch((err) => {
  console.error("[feature-importance] unhandled error:", err);
  process.exit(1);
});
