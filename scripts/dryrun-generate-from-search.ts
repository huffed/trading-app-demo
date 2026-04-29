/**
 * Dry-run for generate-from-search: runs the search engine + risk
 * calibrator + Zod validator without writing to Supabase. Prints the
 * resulting AlgorithmRules + metadata so the operator can sanity-check
 * what the autonomous-create flow would persist.
 *
 * Mirrors generateAlgorithmFromSearchForUser (in algorithms/
 * generate-from-search-actions.ts) up to but not including the DB
 * insert. If this script's output looks correct, the live action will
 * persist exactly that shape.
 *
 * Run with default friend-watchlist input:
 *   npx tsx scripts/dryrun-generate-from-search.ts
 *
 * Override via env:
 *   CAPITAL=10000 TARGET=3 npx tsx scripts/dryrun-generate-from-search.ts
 */
import { readFileSync } from "fs";
import { runCombinatorialSearch } from "../src/lib/algorithm/combinatorial-search";
import { calibrateRiskToTarget } from "../src/lib/algorithm/combinatorial-search/calibrate";
import { timeframeToInterval, type BarInterval } from "../src/lib/market-data/interval";
import { fetchDailyPrices } from "../src/lib/market-data/prices";
import type { PriceBar } from "../src/lib/market-data/types";
import { algorithmRulesSchema } from "../src/lib/validators/algorithm";

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

async function loadCorpus(
  symbols: string[],
  timeframes: string[]
): Promise<Map<string, Map<string, PriceBar[]>>> {
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
  return out;
}

async function main() {
  const capital = Number(process.env.CAPITAL ?? "20000");
  const target = Number(process.env.TARGET ?? "5");
  const symbolsArg = process.env.SYMBOLS ?? "XAU/USD,EUR/USD,GBP/USD";
  const symbols = symbolsArg.split(",").map((s) => s.trim()).filter(Boolean);

  console.log("Dry-run generate-from-search");
  console.log(`  capital            : $${capital.toLocaleString()}`);
  console.log(`  monthly_target_pct : ${target}%`);
  console.log(`  symbols            : ${symbols.join(", ")}\n`);

  console.log("Fetching prices...");
  const start = Date.now();

  const result = await runCombinatorialSearch(
    {
      capital,
      monthly_target_pct: target,
      prefer_symbols: symbols,
    },
    loadCorpus,
    { max_candidates: 30, top_n: 1 }
  );

  console.log(`\nSearch complete in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  console.log(`  evaluated : ${result.candidates_evaluated}`);
  console.log(`  passed    : ${result.candidates_passed}\n`);

  if (result.top.length === 0) {
    console.log("No top candidate. UI would surface 'Try lowering target or broadening filters'.");
    return;
  }

  const picked = result.top[0];
  console.log(`Top candidate: ${picked.label}`);
  console.log(`  pre-cal monthly_pct  : ${picked.monthly_return_pct.toFixed(2)}%`);
  console.log(`  worst_dd_pct         : ${picked.worst_dd_pct.toFixed(2)}%`);
  console.log(`  walk-forward windows : ${picked.walk_forward.total_windows}`);
  console.log(
    `  green-window rate    : ${(picked.walk_forward.win_rate_of_windows * 100).toFixed(0)}%`
  );
  console.log(`  symbols              : ${picked.symbols.join(", ")}`);

  const calibration = calibrateRiskToTarget(picked.rules, picked.monthly_return_pct, target);
  console.log(`\nCalibration:`);
  console.log(`  scaling_factor       : ${calibration.scaling_factor.toFixed(2)}x`);
  console.log(
    `  base risk            : ${calibration.original_value} → ${calibration.calibrated_value}`
  );
  console.log(`  capped               : ${calibration.capped ? "YES (FTMO-safe)" : "no"}`);
  console.log(`  estimated_monthly_pct: ${calibration.estimated_monthly_pct.toFixed(2)}%`);

  const parsed = algorithmRulesSchema.safeParse(calibration.rules);
  if (!parsed.success) {
    console.log(`\nFAIL: Calibrated rules failed Zod validation`);
    for (const issue of parsed.error.issues.slice(0, 5)) {
      console.log(`  ${issue.path.join(".")}: ${issue.message}`);
    }
    return;
  }
  console.log(`\nZod validation: ✓ rules ready to insert`);

  const r = calibration.rules;
  console.log(`\nResulting algorithm rules:`);
  console.log(`  timeframe       : ${r.timeframe}`);
  console.log(`  asset_class     : ${r.asset_class}`);
  console.log(`  side            : ${r.side ?? "long"}`);
  console.log(`  entry_logic     : ${JSON.stringify(r.entry_logic)}`);
  console.log(`  entry conditions:`);
  for (const c of r.entry_conditions) {
    if (c.type === "pattern") {
      console.log(
        `    [${c.timeframe}] pattern=${c.pattern}  dir=${c.direction ?? "any"}  lookback=${c.lookback ?? "default"}`
      );
    } else if (c.type === "technical") {
      console.log(`    [${c.timeframe}] tech=${c.indicator} ${c.operator} ${c.value}`);
    }
  }
  console.log(`  stop_loss       : ${r.stop_loss.type} ${r.stop_loss.value}`);
  console.log(`  take_profit     : ${r.take_profit.type} ${r.take_profit.value}`);
  console.log(
    `  position_sizing : ${r.position_sizing.type} = ${r.position_sizing.value}` +
      (r.position_sizing.type === "conviction_scaled"
        ? ` (max ${r.position_sizing.max_multiplier ?? 4}× via ${r.position_sizing.conviction_metric ?? "condition_count"})`
        : "")
  );
  console.log(`  max_positions   : ${r.max_positions}`);
  console.log(`  leverage        : ${r.leverage ?? "default"}`);

  console.log("\nGates baked in:");
  console.log(`  regime_filter    : ${r.regime_filter?.enabled ?? false}`);
  console.log(`  adx_filter       : ${r.adx_filter?.enabled ?? false}`);
  console.log(`  stagnant_exit    : ${r.stagnant_exit?.enabled ?? false}`);
  if (r.prop_firm) {
    console.log(`  prop_firm        : DLL ${r.prop_firm.daily_loss_limit}%, max_DD ${r.prop_firm.max_drawdown}%`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
