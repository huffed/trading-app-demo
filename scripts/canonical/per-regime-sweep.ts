/**
 * H.6 — Per-regime sweep driver. Runs runPerRegimeSweep against the
 * specified algo's cached bars and prints the gate verdict.
 *
 * Usage:
 *   ALGO_ID=<uuid> pnpm dlx tsx scripts/canonical/per-regime-sweep.ts
 *
 * Defaults run against the Engulfing rr3_lb6_r06 v3 survivor.
 *
 * Output:
 *   - Per-regime trade counts + best-per-regime variants + Sharpes
 *   - Single-model baseline (best full-bar variant + DSR)
 *   - Regime-routed combined Sharpe + DSR
 *   - DSR delta + literal-spec gate verdict (combined - single >= 0.10)
 *   - Saturated-baseline caveat when single_model DSR > 0.90
 *     (absolute +0.10 unreachable per DSR ∈ [0,1]).
 *
 * Pure-read. No DB writes; rules are not mutated.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { runPerRegimeSweep } from "../../src/lib/algo-search/per-regime-sweep";
import { REGIMES } from "../../src/lib/algorithm/regime-classifier";
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

const ALGO_ID = process.env.ALGO_ID ?? "33b705b9-7442-4c73-8d97-4a88ecacb9a1"; // Engulfing rr3_lb6_r06
const RESULTS_FILE = resolve(process.cwd(), "scripts/canonical/per-regime-sweep-results.json");

function fail(msg: string): never {
  console.error(`[per-regime-sweep] ${msg}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? fail("NEXT_PUBLIC_SUPABASE_URL not set");
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? fail("SUPABASE_SERVICE_ROLE_KEY not set");
  const supabase: SupabaseClient<Database> = createClient(supabaseUrl, serviceKey);

  console.log(`[per-regime-sweep] Loading algo ${ALGO_ID} ...`);
  const { data: algoRow, error: algoErr } = await supabase
    .from("algorithms")
    .select("id, name, capital, rules, algorithm_watchlist(ticker)")
    .eq("id", ALGO_ID)
    .single();
  if (algoErr || !algoRow) fail(`algo fetch failed: ${algoErr?.message ?? "no row"}`);

  const rules = algoRow.rules as unknown as AlgorithmRules;
  const capital = Number(algoRow.capital);
  const watchlist = (algoRow.algorithm_watchlist ?? []) as { ticker: string }[];
  if (watchlist.length === 0) fail(`algo ${ALGO_ID} has no watchlist tickers`);
  const ticker = watchlist[0].ticker;
  const timeframe = rules.timeframe;

  console.log(`  algo:    ${algoRow.name}`);
  console.log(`  capital: $${capital}, ticker: ${ticker}, TF: ${timeframe}`);

  console.log(`[per-regime-sweep] Loading bars for ${ticker} ${timeframe} ...`);
  const { data: barsRow, error: barsErr } = await supabase
    .from("price_cache")
    .select("bars")
    .eq("ticker", ticker.toUpperCase())
    .eq("output_size", "full")
    .eq("interval", timeframe)
    .limit(1)
    .single();
  if (barsErr || !barsRow) fail(`no cached bars: ${barsErr?.message ?? "row missing"}`);
  const bars = barsRow.bars as unknown as PriceBar[];
  console.log(`  ${bars.length} bars (${bars[0]?.date} → ${bars[bars.length - 1]?.date})`);

  console.log(`[per-regime-sweep] Running 96-variant sweep + per-regime classification ...`);
  console.log(`  expect ~5-10 min for the 96 backtests + 4 re-runs for stat-extraction`);
  const result = runPerRegimeSweep(
    { name: algoRow.name, capital, rules, ticker, timeframe },
    bars,
  );

  // Report
  console.log("\n┌──────────────────────────────────────────────────────────────────────┐");
  console.log("│ H.6 per-regime sweep result                                          │");
  console.log("└──────────────────────────────────────────────────────────────────────┘");
  console.log(`  total bars:        ${result.total_bars}`);
  console.log(`  classified bars:   ${result.classified_bars} (rest are pre-lookback nulls)`);
  console.log(`  variants run:      ${result.total_variants}`);

  console.log("\n  Single-model winner (best full-bar Sharpe):");
  console.log(`    variant:  ${result.single_model.variant_tag}`);
  console.log(`    Sharpe:   ${result.single_model.sharpe.toFixed(4)}`);
  console.log(`    DSR:      ${result.single_model.dsr.toFixed(4)}`);

  console.log("\n  Regime-routed (per-regime best):");
  for (const regime of REGIMES) {
    const best = result.regime_routed.per_regime_best[regime];
    console.log(`    [${regime.padEnd(11)}]  variant=${best.variant_tag.padEnd(28)}  Sharpe=${best.sharpe.toFixed(4)}  n=${best.n_trades}`);
  }
  console.log(`    combined Sharpe: ${result.regime_routed.combined_sharpe.toFixed(4)}`);
  console.log(`    combined DSR:    ${result.regime_routed.combined_dsr.toFixed(4)}  (nTrials=288 = 96×3 selection space)`);
  console.log(`    combined trades: ${result.regime_routed.total_trades}`);

  console.log("\n┌──────────────────────────────────────────────────────────────────────┐");
  console.log("│ H.6 gate verdict                                                     │");
  console.log("└──────────────────────────────────────────────────────────────────────┘");
  console.log(`  DSR delta (regime-routed − single-model): ${result.dsr_delta.toFixed(4)}`);
  console.log(`  gate (literal spec: delta >= 0.10):       ${result.passes_gate ? "PASS" : "FAIL"}`);
  if (!result.passes_gate && result.single_model.dsr > 0.90) {
    console.log("\n  SATURATED-BASELINE CAVEAT: single_model DSR is already > 0.90 (near the");
    console.log("  upper bound of DSR ∈ [0, 1]). The absolute +0.10 gate is structurally");
    console.log("  unreachable for saturated baselines — the SPEC GATE FAILS by construction,");
    console.log("  not by signal. Operator-relevant signal is the DELTA itself + the per-regime");
    console.log("  Sharpe spread (does the algo genuinely behave differently across regimes?).");
  }

  // Persist for downstream (H.7 regime_filter reconciliation may consume)
  const persist = {
    generated_for_algo_id: ALGO_ID,
    ticker, timeframe,
    total_bars: result.total_bars,
    classified_bars: result.classified_bars,
    single_model: result.single_model,
    regime_routed: {
      per_regime_best: result.regime_routed.per_regime_best,
      combined_sharpe: result.regime_routed.combined_sharpe,
      combined_dsr: result.regime_routed.combined_dsr,
      total_trades: result.regime_routed.total_trades,
    },
    dsr_delta: result.dsr_delta,
    passes_gate: result.passes_gate,
  };
  writeFileSync(RESULTS_FILE, JSON.stringify(persist, null, 2));
  console.log(`\n  persisted: ${RESULTS_FILE}`);
}

main().catch((err) => {
  console.error("[per-regime-sweep] unhandled error:", err);
  process.exit(1);
});
