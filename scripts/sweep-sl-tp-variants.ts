/**
 * Sweeps structural SL/TP variants on a given algorithm and reports
 * walk-forward metrics for each. Used to find regime-adaptive SL/TP
 * configs that pass the search engine's standard criteria. Built after
 * the percentage→swing_anchor swap on Algo D produced 6.6× return
 * improvement and pulled worst-window DD inside the 10% bar.
 *
 * Variant grid:
 *  - stop_loss type=swing_anchor: lookback ∈ {5, 8, 12}, value ∈ {0, 0.25, 0.5}
 *  - take_profit type=rr_multiple: value ∈ {2, 3, 4}
 *  - + the algo's existing baseline (whatever's currently persisted)
 *
 * Usage:
 *   ALGO_ID=<uuid> pnpm dlx tsx scripts/sweep-sl-tp-variants.ts
 *
 * Pass criteria (same as combinatorial-search/evaluator.ts):
 *  - win_rate_of_windows >= 0.6
 *  - mean_drawdown <= 8%
 *  - worst_window_dd <= 10%
 *  - mean_return per window >= 0.05% of capital
 */
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import { runWalkForward } from "../src/lib/market-data/walk-forward";
import { fetchDailyPrices } from "../src/lib/market-data/prices";
import {
  defaultWalkForwardStepDays,
  defaultWalkForwardWindowDays,
  timeframeToInterval,
} from "../src/lib/market-data/interval";
import type { PriceBar } from "../src/lib/market-data/types";
import type { AlgorithmRules } from "../src/types/algorithm";

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

interface VariantResult {
  name: string;
  total_windows: number;
  win_rate_of_windows: number;
  mean_return: number;
  std_return: number;
  mean_drawdown: number;
  worst_dd: number;
  total_trades: number;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

async function main(): Promise<void> {
  const algoId = process.env.ALGO_ID;
  if (!algoId) throw new Error("ALGO_ID env var required");

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
  const { data: algo, error: algoErr } = await supabase
    .from("algorithms")
    .select("id, name, capital, rules")
    .eq("id", algoId)
    .single();
  if (algoErr || !algo) throw new Error(`algo not found: ${algoErr?.message}`);
  const algoRow = algo as { id: string; name: string; capital: number; rules: AlgorithmRules };

  const { data: wl } = await supabase
    .from("algorithm_watchlist")
    .select("ticker")
    .eq("algorithm_id", algoId);
  const tickers = (wl as { ticker: string }[]).map((w) => w.ticker);
  if (tickers.length === 0) throw new Error("no watchlist tickers");

  const tf = algoRow.rules.timeframe;
  const interval = timeframeToInterval(tf);
  const wfWindowDays = defaultWalkForwardWindowDays(tf);
  const wfStepDays = defaultWalkForwardStepDays(tf);

  console.log(`Algo: ${algoRow.name}`);
  console.log(`  id        : ${algoRow.id}`);
  console.log(`  side      : ${algoRow.rules.side ?? "long"}`);
  console.log(`  timeframe : ${tf} (${interval})`);
  console.log(`  tickers   : ${tickers.join(", ")}`);
  console.log(`  walk-forward: ${wfWindowDays}d windows × ${wfStepDays}d step`);
  console.log("");

  const pricesByTicker = new Map<string, PriceBar[]>();
  for (const t of tickers) {
    const bars = await fetchDailyPrices(t, "full", interval);
    pricesByTicker.set(t, bars);
  }
  for (const [t, bars] of pricesByTicker) {
    console.log(
      `  ${t} corpus: ${bars.length} bars (${bars[0]?.date} → ${bars[bars.length - 1]?.date})`
    );
  }
  console.log("");

  const baseRules = algoRow.rules;
  const capital = Number(algoRow.capital);

  const variants: { name: string; rules: AlgorithmRules }[] = [
    { name: "baseline (persisted)", rules: baseRules },
  ];
  for (const lookback of [5, 8, 12]) {
    for (const buffer of [0, 0.25, 0.5]) {
      for (const rr of [2, 3, 4]) {
        const variant: AlgorithmRules = {
          ...baseRules,
          stop_loss: {
            type: "swing_anchor",
            value: buffer,
            lookback,
            atr_period: 14,
          },
          take_profit: {
            type: "rr_multiple",
            value: rr,
          },
        };
        variants.push({
          name: `swing lb=${lookback} buf=${buffer} · rr=${rr}`,
          rules: variant,
        });
      }
    }
  }

  console.log(`Running walk-forward on ${variants.length} variants...`);
  console.log("");

  const results: VariantResult[] = [];
  for (const v of variants) {
    const wf = runWalkForward(v.rules, pricesByTicker, capital, {
      testWindowDays: wfWindowDays,
      stepDays: wfStepDays,
    });
    const worstDd = wf.windows.reduce((max, w) => Math.max(max, w.max_drawdown), 0);
    const totalTrades = wf.windows.reduce((sum, w) => sum + w.total_trades, 0);
    results.push({
      name: v.name,
      total_windows: wf.total_windows,
      win_rate_of_windows: wf.win_rate_of_windows,
      mean_return: wf.mean_return,
      std_return: wf.std_return,
      mean_drawdown: wf.mean_drawdown,
      worst_dd: worstDd,
      total_trades: totalTrades,
    });
  }

  const PASS_GREEN = 0.6;
  const PASS_MEAN_DD = 8;
  const PASS_WORST_DD = 10;
  const PASS_RETURN_PCT_PER_WINDOW = 0.05;

  console.log(
    pad("variant", 38) +
      pad("windows", 9) +
      pad("green%", 8) +
      pad("trades", 8) +
      pad("mean$", 11) +
      pad("std$", 10) +
      pad("meanDD%", 10) +
      pad("worstDD%", 10) +
      "pass?"
  );
  console.log("-".repeat(108));
  for (const r of results) {
    const greenPct = r.win_rate_of_windows * 100;
    const passGreen = r.win_rate_of_windows >= PASS_GREEN;
    const passMeanDd = r.mean_drawdown <= PASS_MEAN_DD;
    const passWorstDd = r.worst_dd <= PASS_WORST_DD;
    const passReturn =
      (r.mean_return / capital) * 100 >= PASS_RETURN_PCT_PER_WINDOW;
    const pass = passGreen && passMeanDd && passWorstDd && passReturn;
    console.log(
      pad(r.name, 38) +
        pad(String(r.total_windows), 9) +
        pad(greenPct.toFixed(0) + "%", 8) +
        pad(String(r.total_trades), 8) +
        pad(`$${r.mean_return.toFixed(0)}`, 11) +
        pad(`$${r.std_return.toFixed(0)}`, 10) +
        pad(r.mean_drawdown.toFixed(2) + "%", 10) +
        pad(r.worst_dd.toFixed(2) + "%", 10) +
        (pass ? "PASS" : "fail")
    );
  }
  console.log("");

  const scored = results.map((r) => ({
    ...r,
    score:
      r.win_rate_of_windows * 100 +
      (r.mean_return / capital) * 100 -
      r.worst_dd * 0.5 -
      r.mean_drawdown,
  }));
  scored.sort((a, b) => b.score - a.score);

  console.log("Top 5 by composite score (green% + return%/win - 0.5×worstDD - meanDD):");
  for (const r of scored.slice(0, 5)) {
    console.log(
      `  ${pad(r.name, 36)} score=${r.score.toFixed(2)}  green=${(r.win_rate_of_windows * 100).toFixed(0)}%  mean=$${r.mean_return.toFixed(0)}  worstDD=${r.worst_dd.toFixed(2)}%`
    );
  }

  const passing = results.filter((r) => {
    return (
      r.win_rate_of_windows >= PASS_GREEN &&
      r.mean_drawdown <= PASS_MEAN_DD &&
      r.worst_dd <= PASS_WORST_DD &&
      (r.mean_return / capital) * 100 >= PASS_RETURN_PCT_PER_WINDOW
    );
  });
  console.log("");
  console.log(`Passing variants: ${passing.length} / ${variants.length}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
