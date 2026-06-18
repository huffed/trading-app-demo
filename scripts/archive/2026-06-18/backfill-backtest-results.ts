/**
 * Backfill algorithms.backtest_results for the 13 paper algos that
 * were deployed before this column was being persisted. Closes the
 * gap surfaced by PR #272 (live-mirror eligibility dashboard) where
 * every paper algo showed "Ready (verify manually)" because the
 * dashboard couldn't compute expected R without backtest_results.
 *
 * Data sources (per-algo):
 *   - scripts/deploy-multi-instrument-batch-2026-06-16.ts source citations
 *   - scripts/REVALIDATION_REPORT_2026_06_16.md per-algo cells
 *   - scripts/REPORT_228_PATTERN_CONFLUENCE_2026_06_16.md (gold + USD/JPY FVG-DailyBias)
 *   - scripts/deploy-fvg-dailybias-long-4h-usdjpy.ts header docstring
 *
 * **Capital scaling note:** all walk-forward runs use $100K capital
 * (`scripts/library-walk-forward.ts` default). Most deployed algos run
 * at $10K. R-per-trade is scale-invariant (it's a ratio of P&L to risk,
 * both of which scale linearly), so we rescale total_return by
 * `algo.capital / WALK_FORWARD_CAPITAL` before persisting. The stored
 * total_return then represents "what this algo would have produced at
 * its actual capital", and the dashboard's expected_R math
 * `(total_return / total_trades) / 1R$` produces the correct R
 * regardless of capital scale.
 *
 * What's populated:
 *   - total_return — exact walk-forward $, RESCALED to algo.capital
 *   - total_trades — exact, from operator-validated walk-forward
 *   - max_drawdown — exact where source includes it; placeholder 5.0 (just below
 *     the 5% disqualification gate) for the 4 cells where the source citation
 *     didn't include the DD — those rows have `dd_estimated: true` in the
 *     JSON so the operator can spot-fix later
 *   - win_rate, sharpe_ratio, equity_curve — set to 0 / [] (walk-forward
 *     doesn't emit these in a comparable form; the dashboard uses only
 *     total_return + total_trades for its variance check)
 *
 * Idempotent: skip rows that already have backtest_results.
 *
 * Usage:
 *   DRY_RUN=1 pnpm dlx tsx scripts/backfill-backtest-results.ts    # default
 *   APPLY=1   pnpm dlx tsx scripts/backfill-backtest-results.ts    # write
 */
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";

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

const APPLY = process.env.APPLY === "1";
const WALK_FORWARD_CAPITAL = 100_000;

interface BackfillRow {
  /** Exact algorithm name as it appears in the algorithms table. */
  name: string;
  total_return: number;
  total_trades: number;
  max_drawdown: number;
  /** True when max_drawdown is a placeholder (5.0) rather than exact. */
  dd_estimated?: boolean;
  /** Where these numbers come from — written into a side note column
   *  via the `notes` field on backtest_results for future audit. */
  source: string;
}

const BACKFILL: BackfillRow[] = [
  // ---------- Gold ----------
  {
    name: "Library: Gold FVG-DailyBias-Long 4h",
    total_return: 32000,
    total_trades: 141,
    max_drawdown: 4.15,
    source: "REPORT_228_PATTERN_CONFLUENCE B0 baseline XAU/USD (PR #258)",
  },
  {
    name: "Library: Gold OTE-Long 4h",
    total_return: 29713,
    total_trades: 207,
    max_drawdown: 4.1,
    source: "REVALIDATION_REPORT 2026-06-16 rr=3 lb=3 cell (PR #263)",
  },
  {
    name: "Library: Gold FVG-Long 30m",
    total_return: 26775,
    total_trades: 80,
    max_drawdown: 5.0,
    dd_estimated: true,
    source: "REVALIDATION_REPORT 2026-06-16 rr=3 lb=3 cell (PR #259 sweep)",
  },
  {
    name: "Library: Gold Coil-Breakout 4h",
    total_return: 25879,
    total_trades: 111,
    max_drawdown: 2.32,
    source: "REVALIDATION_REPORT 2026-06-16 rr=2 lb=3 cell (PR #259 sweep)",
  },
  {
    name: "Library: Gold sweep_reclaim-DailyBias-Long 4h",
    total_return: 16401,
    total_trades: 64,
    max_drawdown: 5.0,
    dd_estimated: true,
    source: "deploy-multi-instrument-batch source citation (PR #262)",
  },
  // ---------- USD/JPY ----------
  {
    name: "Library: USD/JPY FVG-DailyBias-Long 4h",
    total_return: 108421,
    total_trades: 302,
    max_drawdown: 5.25,
    source: "deploy-fvg-dailybias-long-4h-usdjpy.ts docstring (PR #264)",
  },
  {
    name: "Library: USD/JPY Coil-Breakout-Long 4h",
    total_return: 30786,
    total_trades: 312,
    max_drawdown: 4.10,
    source: "deploy-multi-instrument-batch source citation (PR #261)",
  },
  {
    name: "Library: USD/JPY Dip-Buyer-Long 4h",
    total_return: 27419,
    total_trades: 80,
    max_drawdown: 5.0,
    dd_estimated: true,
    source: "deploy-multi-instrument-batch source citation (PR #261)",
  },
  {
    name: "Library: USD/JPY sweep_reclaim-DailyBias-Long 4h",
    total_return: 14605,
    total_trades: 58,
    max_drawdown: 4.62,
    source: "deploy-multi-instrument-batch source citation (PR #262)",
  },
  // ---------- EUR/USD ----------
  {
    name: "Library: EUR/USD FVG-DailyBias-Long 4h",
    total_return: 44310,
    total_trades: 262,
    max_drawdown: 3.55,
    source: "deploy-multi-instrument-batch source citation (PR #261)",
  },
  {
    name: "Library: EUR/USD Dip-Buyer-Long 4h",
    total_return: 14411,
    total_trades: 48,
    max_drawdown: 5.0,
    dd_estimated: true,
    source: "deploy-multi-instrument-batch source citation (PR #261)",
  },
  // ---------- GBP/USD ----------
  {
    name: "Library: GBP/USD FVG-DailyBias-Long 4h",
    total_return: 49719,
    total_trades: 256,
    max_drawdown: 2.96,
    source: "deploy-multi-instrument-batch source citation (PR #261)",
  },
  {
    name: "Library: GBP/USD Dip-Buyer-Long 4h",
    total_return: 14645,
    total_trades: 60,
    max_drawdown: 5.0,
    dd_estimated: true,
    source: "deploy-multi-instrument-batch source citation (PR #261)",
  },
];

function toBacktestResults(row: BackfillRow, algoCapital: number): Record<string, unknown> {
  // Rescale walk-forward total_return ($100K capital baseline) to the
  // algo's actual deployed capital. R-per-trade is scale-invariant so
  // the dashboard's variance check gets the same answer either way; but
  // storing the rescaled $ means future readers (charts, summaries)
  // see the right number for THIS algo's account size.
  const scale = algoCapital / WALK_FORWARD_CAPITAL;
  const scaledReturn = Math.round(row.total_return * scale);
  return {
    total_return: scaledReturn,
    total_trades: row.total_trades,
    max_drawdown: row.max_drawdown,
    win_rate: 0,
    sharpe_ratio: 0,
    equity_curve: [],
    // Backfill audit metadata — operator-readable, not consumed by UI.
    _backfill: {
      source: row.source,
      dd_estimated: row.dd_estimated ?? false,
      walk_forward_capital: WALK_FORWARD_CAPITAL,
      algo_capital: algoCapital,
      walk_forward_total_return: row.total_return,
      scale,
      backfilled_at: "2026-06-17",
      backfill_script: "scripts/backfill-backtest-results.ts",
    },
  };
}

async function main(): Promise<void> {
  console.log(`\n===== Backfill backtest_results @ ${new Date().toISOString().slice(0, 16)} =====`);
  console.log(`Mode: ${APPLY ? "APPLY (writing to Supabase)" : "DRY_RUN (no writes)"}`);
  console.log(`Backfill set: ${BACKFILL.length} algos\n`);

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    process.exit(1);
  }
  const supabase = createClient(url, serviceKey, { auth: { persistSession: false } });

  let updated = 0;
  let skipped = 0;
  let missing = 0;

  for (const row of BACKFILL) {
    const { data: existing, error: queryErr } = await supabase
      .from("algorithms")
      .select("id, name, capital, backtest_results, rules")
      .eq("name", row.name)
      .maybeSingle();

    if (queryErr) {
      console.error(`✗ query failed for "${row.name}": ${queryErr.message}`);
      continue;
    }
    if (!existing) {
      console.log(`  ⚠ no row for "${row.name}" (deploy may have a different name)`);
      missing++;
      continue;
    }
    if (existing.backtest_results) {
      console.log(`  ⊝ skip "${row.name}" (already has backtest_results)`);
      skipped++;
      continue;
    }

    const algoCapital = existing.capital as number;
    const payload = toBacktestResults(row, algoCapital);
    const sizing = (existing.rules as Record<string, unknown>)?.position_sizing as
      | Record<string, unknown>
      | undefined;
    const riskPct = typeof sizing?.value === "number" ? (sizing.value as number) : 0.6;
    const oneR = algoCapital * (riskPct / 100);
    const scaledReturn = payload.total_return as number;
    const expectedR = oneR > 0 ? scaledReturn / row.total_trades / oneR : null;
    const ddMark = row.dd_estimated ? `~${row.max_drawdown}% (estimated)` : `${row.max_drawdown}%`;
    console.log(
      `  ${APPLY ? "✓" : "→"} "${row.name}":`
    );
    console.log(
      `      walk-forward: $${row.total_return.toLocaleString()} (at $${WALK_FORWARD_CAPITAL.toLocaleString()} cap) / ${row.total_trades} trades / DD ${ddMark}`
    );
    console.log(
      `      rescaled to $${algoCapital.toLocaleString()} algo cap: $${scaledReturn.toLocaleString()}`
    );
    console.log(`      ${row.source}`);
    console.log(
      `      expected R / trade (risk ${riskPct}% → 1R = $${oneR.toLocaleString()}) = ${expectedR == null ? "n/a" : expectedR.toFixed(3)}`
    );

    if (!APPLY) continue;
    const { error: updateErr } = await supabase
      .from("algorithms")
      .update({ backtest_results: payload })
      .eq("id", existing.id);
    if (updateErr) {
      console.error(`  ✗ write failed: ${updateErr.message}`);
      continue;
    }
    updated++;
  }

  console.log(`\n----- Summary -----`);
  console.log(`  Updated: ${updated}`);
  console.log(`  Skipped (already populated): ${skipped}`);
  console.log(`  Missing (algo name not found): ${missing}`);
  console.log(`  Mode: ${APPLY ? "APPLY" : "DRY_RUN — re-run with APPLY=1 to write"}\n`);
}

void main();
