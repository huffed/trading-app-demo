/**
 * End-to-end smoke test for the multi-TF templates: runs the full
 * combinatorial search engine against the friend's watchlist
 * (XAU/USD + EUR/USD + GBP/USD), then filters results to the
 * `multi_tf_*` templates and reports walk-forward outcomes.
 *
 * Uses fetchDailyPrices (Twelve Data → Yahoo → Alpha Vantage fallback
 * chain) directly — bypasses the production Supabase price-cache (which
 * requires a Next.js request scope). When Twelve Data's daily cap is
 * hit, Yahoo serves the bars and the test still runs.
 *
 * Run: npx tsx scripts/smoke-multi-tf-walkforward.ts
 */
import { readFileSync } from "fs";
import { runCombinatorialSearch } from "../src/lib/algorithm/combinatorial-search";
import { timeframeToInterval, type BarInterval } from "../src/lib/market-data/interval";
import { fetchDailyPrices } from "../src/lib/market-data/prices";
import type { PriceBar } from "../src/lib/market-data/types";

// Manual env loader — provider keys live in .env.local.
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

/**
 * Loader that uses the production Twelve Data → Yahoo → Alpha Vantage
 * fallback chain via fetchDailyPrices. Bypasses the Supabase price-cache
 * (which needs a Next.js request scope) but keeps every other provider
 * behaviour identical to live. Yahoo serves intraday too — keeps the
 * smoke test runnable when Twelve Data's daily cap has been hit.
 */
async function loadCorpusFallback(
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

  const tasks: Array<{ symbol: string; interval: BarInterval }> = [];
  for (const iv of intervals) for (const s of symbols) tasks.push({ symbol: s, interval: iv });

  // Sequential. fetchDailyPrices already handles per-provider rate
  // limits internally; piling on parallelism just wastes credits when
  // Twelve Data 429s and we end up on Yahoo anyway.
  for (const t of tasks) {
    try {
      const bars = await fetchDailyPrices(t.symbol, "full", t.interval);
      if (bars.length >= 100) byInterval.get(t.interval)!.set(t.symbol, bars);
      console.log(`  ${t.symbol} ${t.interval}: ${bars.length} bars`);
    } catch (err) {
      console.log(`  ${t.symbol} ${t.interval}: FAIL (${(err as Error).message})`);
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
  const start = Date.now();
  console.log("Smoke-testing multi-TF templates against friend watchlist...\n");

  const result = await runCombinatorialSearch(
    {
      capital: 20_000,
      monthly_target_pct: 10,
      prefer_symbols: ["XAU/USD", "EUR/USD", "GBP/USD"],
    },
    loadCorpusFallback,
    { include_evaluated: true, top_n: 10 }
  );

  const elapsedSec = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\nSearch complete in ${elapsedSec}s`);
  console.log(`  candidates evaluated : ${result.candidates_evaluated}`);
  console.log(`  candidates passed    : ${result.candidates_passed}\n`);

  const evaluated = result.all_evaluated ?? [];
  const focused = evaluated.filter(
    (c) => c.label.startsWith("multi_tf_") || c.label.startsWith("momentum_")
  );

  if (focused.length === 0) {
    console.log("No multi_tf_* or momentum_* candidates surfaced — check grid wiring.");
    return;
  }

  console.log(`Focused candidates evaluated: ${focused.length}\n`);
  console.log(
    "label                                       tf    side    monthly%   wf_green   targetMet   ddSafe   passes"
  );
  console.log(
    "-----------------------------------------------------------------------------------------------------------"
  );
  for (const c of focused) {
    const passes =
      c.pass_criteria.walk_forward_green &&
      c.pass_criteria.target_met &&
      c.pass_criteria.dd_safe;
    const row = [
      c.label.padEnd(42),
      c.rules.timeframe.padEnd(5),
      (c.rules.side ?? "long").padEnd(7),
      c.monthly_return_pct.toFixed(2).padStart(7),
      c.pass_criteria.walk_forward_green ? "  YES   " : "  no    ",
      c.pass_criteria.target_met ? "  YES    " : "  no     ",
      c.pass_criteria.dd_safe ? "  YES  " : "  no   ",
      passes ? "  PASS" : "  FAIL",
    ].join("  ");
    console.log(row);
  }
  console.log();

  const passing = focused.filter(
    (c) =>
      c.pass_criteria.walk_forward_green &&
      c.pass_criteria.target_met &&
      c.pass_criteria.dd_safe
  );
  console.log(`Focused passes: ${passing.length} / ${focused.length}`);
  if (passing.length > 0) {
    const top = passing[0];
    console.log("\nTop multi-TF candidate:");
    console.log(`  label: ${top.label}`);
    console.log(`  symbols: ${top.symbols.join(", ")}`);
    console.log(`  score: ${top.score.toFixed(3)}`);
    console.log(`  monthly_return_pct: ${top.monthly_return_pct.toFixed(2)}`);
    console.log(`  worst_dd_pct: ${top.worst_dd_pct.toFixed(2)}`);
    console.log(`  walk_forward windows: ${top.walk_forward.total_windows}`);
    const greens = top.walk_forward.windows.filter((w) => w.total_return > 0).length;
    console.log(`  green windows: ${greens}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
