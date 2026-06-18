/**
 * Recompute algorithms.backtest_results from the just-backfilled
 * backtest_trades rows. Closes the loop after the 2026-06-17 daily_bias
 * look-ahead fix: every walk-forward stat in backfill-backtest-results.ts
 * and the deploy-script citation comments was produced before the fix
 * and is therefore mis-stated to the degree of the end-of-window vs
 * in-sample bias gap. The backtest_trades table is now the source of
 * truth (full-history engine run with the fix applied) — this script
 * derives aggregate stats from those trades and writes them back to
 * algorithms.backtest_results so the dashboard's expected-R variance
 * check (per the live-mirror eligibility tab) is calibrated against
 * the corrected baseline.
 *
 * Computed fields:
 *   - total_return: SUM(pnl) across all backtest_trades for the algo
 *   - total_trades: COUNT
 *   - max_drawdown: peak-to-trough percent drawdown on the cumulative
 *     pnl curve, expressed as a percentage of starting capital
 *   - win_rate: percentage of trades with pnl > 0
 *   - sharpe_ratio, equity_curve: left at 0 / [] (out of scope here;
 *     populated by walk-forward when needed)
 *
 * Audit metadata writes `_recomputed` under backtest_results.
 *
 * Usage:
 *   DRY_RUN=1 pnpm dlx tsx scripts/recompute-backtest-results-from-trades.ts   # default
 *   APPLY=1   pnpm dlx tsx scripts/recompute-backtest-results-from-trades.ts   # write
 *   APPLY=1 ONLY="Library: Gold FVG-DailyBias-Long 4h"                         # one algo
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
  } catch {}
}

const APPLY = process.env.APPLY === "1";
const ONLY = process.env.ONLY ?? "";

interface TradeRow {
  entry_date: string;
  exit_date: string;
  pnl: number | string;
}

interface AlgoRow {
  id: string;
  name: string;
  capital: number;
  backtest_results: Record<string, unknown> | null;
}

interface Stats {
  total_return: number;
  total_trades: number;
  max_drawdown: number;
  win_rate: number;
  /** Cumulative pnl at each trade-exit point. */
  equity_curve: { date: string; value: number }[];
}

function computeStats(trades: TradeRow[], capital: number): Stats {
  if (trades.length === 0) {
    return { total_return: 0, total_trades: 0, max_drawdown: 0, win_rate: 0, equity_curve: [] };
  }
  const sorted = [...trades].sort(
    (a, b) => new Date(a.exit_date).getTime() - new Date(b.exit_date).getTime()
  );
  let cum = 0;
  let peak = 0;
  let maxDdPct = 0;
  let wins = 0;
  const curve: { date: string; value: number }[] = [];
  for (const t of sorted) {
    const pnl = Number(t.pnl);
    cum += pnl;
    if (pnl > 0) wins++;
    if (cum > peak) peak = cum;
    const ddPct = ((peak - cum) / capital) * 100;
    if (ddPct > maxDdPct) maxDdPct = ddPct;
    curve.push({ date: t.exit_date, value: Math.round(cum * 100) / 100 });
  }
  return {
    total_return: Math.round(cum * 100) / 100,
    total_trades: sorted.length,
    max_drawdown: Math.round(maxDdPct * 100) / 100,
    win_rate: Math.round((wins / sorted.length) * 1000) / 10,
    equity_curve: curve,
  };
}

async function main(): Promise<void> {
  console.log(`\n===== Recompute backtest_results @ ${new Date().toISOString().slice(0, 16)} =====`);
  console.log(`Mode: ${APPLY ? "APPLY (writing to Supabase)" : "DRY_RUN (no writes)"}`);
  if (ONLY) console.log(`ONLY=${ONLY}`);
  console.log();

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const supabase = createClient(url, key, { auth: { persistSession: false } });

  let query = supabase.from("algorithms").select("id, name, capital, backtest_results").order("name", { ascending: true });
  if (ONLY) query = query.eq("name", ONLY);
  const algoRes = await query;
  if (algoRes.error) {
    console.error(`Algo fetch failed: ${algoRes.error.message}`);
    process.exit(1);
  }
  const algos = (algoRes.data ?? []) as unknown as AlgoRow[];

  let updated = 0;
  let zeroSkipped = 0;
  console.log(`${"ALGO".padEnd(54)} ${"PRIOR $".padStart(12)} ${"NEW $".padStart(12)} ${"TRADES".padStart(7)} ${"DD%".padStart(6)} ${"WR%".padStart(6)}`);
  console.log("-".repeat(112));

  for (const algo of algos) {
    const tradesRes = await supabase
      .from("backtest_trades")
      .select("entry_date, exit_date, pnl")
      .eq("algorithm_id", algo.id);
    const trades = (tradesRes.data ?? []) as TradeRow[];
    if (trades.length === 0) {
      zeroSkipped++;
      continue;
    }
    const stats = computeStats(trades, algo.capital);
    const priorReturn = (algo.backtest_results as { total_return?: number } | null)?.total_return ?? 0;
    console.log(
      `${algo.name.slice(0, 54).padEnd(54)} ${("$" + priorReturn.toLocaleString()).padStart(12)} ${("$" + stats.total_return.toLocaleString()).padStart(12)} ${String(stats.total_trades).padStart(7)} ${stats.max_drawdown.toFixed(2).padStart(6)} ${stats.win_rate.toFixed(1).padStart(6)}`
    );

    if (!APPLY) continue;
    const payload = {
      ...stats,
      sharpe_ratio: 0,
      _recomputed: {
        from: "backtest_trades",
        at: new Date().toISOString(),
        prior_total_return: priorReturn,
        note: "post-daily_bias-lookahead-fix 2026-06-17 — see feedback_daily_bias_lookahead_bug.md",
      },
    };
    const up = await supabase
      .from("algorithms")
      .update({ backtest_results: payload as never })
      .eq("id", algo.id);
    if (up.error) {
      console.error(`  ✗ write failed for ${algo.name}: ${up.error.message}`);
      continue;
    }
    updated++;
  }

  console.log(`\n----- Summary -----`);
  if (APPLY) console.log(`  Updated: ${updated}`);
  else console.log(`  Would update: ${algos.length - zeroSkipped}`);
  console.log(`  Skipped (0 trades): ${zeroSkipped}`);
  console.log(`  Mode: ${APPLY ? "APPLY" : "DRY_RUN — re-run with APPLY=1 to write"}\n`);
}

void main();
