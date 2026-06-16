/**
 * Geometry sweep for FVG+DailyBias-Long 4h.
 *
 * Pre-deploy validation step (S1.5). Sweeps SL/TP variants over the
 * 2020→present 4h corpus to see whether the proposed live geometry
 * (swing_anchor 0.10/4 + rr_multiple 3) is locally near-optimal or
 * whether a nearby variant beats it.
 *
 * Grid (9 cells):
 *   RR multiple ∈ {2, 3, 5}
 *   SL lookback ∈ {3, 4, 6}   (SL value fixed at 0.10 buffer)
 *
 * Output: per-cell summary table sorted by total return. Flags any
 * variant that pushes green % ≥60 AND beats the proposed config on
 * total return. WARNING: optimisation on the same dataset = overfit
 * risk; treat ANY large improvement skeptically. Only ship a variant
 * if it beats by a wide margin AND survives the per-year decomp (the
 * 2021 distribution-year stays containable).
 *
 * Usage:
 *   pnpm dlx tsx scripts/sweep-fvg-dailybias-geometry.ts
 */
import { readFileSync, writeFileSync } from "fs";
import { runWalkForward } from "../src/lib/market-data/walk-forward";
import type { PriceBar } from "../src/lib/market-data/types";
import type { AlgorithmRules } from "../src/types/algorithm";
import { loadCorpus, type Corpus } from "./llm-trader-backtest";

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

const WINDOW_DAYS = 40;
const STEP_DAYS = 40;
const CAPITAL = 100_000;
const TICKER = "XAU/USD";
const RR_GRID = [2, 3, 5];
const LOOKBACK_GRID = [3, 4, 6];

interface Cell {
  rr: number;
  lookback: number;
  windows: number;
  windows_with_trades: number;
  green_pct: number;
  trades: number;
  total_ret: number;
  worst_dd: number;
  dd_breaches_gt5: number;
  per_year: Record<string, { trades: number; return: number; green_pct: number; windows: number }>;
}

function makeRules(rr: number, lookback: number): AlgorithmRules {
  return {
    entry_conditions: [
      { type: "pattern", pattern: "fvg", direction: "bullish", timeframe: "4h" },
      { type: "pattern", pattern: "daily_bias", direction: "bullish", ma_period: 20, timeframe: "4h" },
    ],
    exit_conditions: [],
    entry_logic: "all",
    stop_loss: { type: "swing_anchor", value: 0.1, lookback },
    take_profit: { type: "rr_multiple", value: rr },
    position_sizing: { type: "risk_per_trade", value: 0.6 },
    max_positions: 1,
    leverage: 9,
    timeframe: "4h",
    asset_class: "commodity",
    side: "long",
    stagnant_exit: { enabled: true },
  } as AlgorithmRules;
}

async function main(): Promise<void> {
  console.log(`Loading XAU/USD 4h corpus...`);
  const corpus: Corpus = await loadCorpus("4h");
  const bars: PriceBar[] = corpus.bars;
  console.log(`  ${bars.length} bars (${bars[0]?.date.slice(0, 10)} → ${bars[bars.length - 1]?.date.slice(0, 10)})\n`);

  const prices = new Map([[TICKER, bars]]);
  const cells: Cell[] = [];

  for (const rr of RR_GRID) {
    for (const lookback of LOOKBACK_GRID) {
      const rules = makeRules(rr, lookback);
      const summary = runWalkForward(rules, prices, CAPITAL, {
        testWindowDays: WINDOW_DAYS,
        stepDays: STEP_DAYS,
        marketStateSeries: null,
      });
      const traded = summary.windows.filter((w) => w.total_trades > 0);
      const green = traded.filter((w) => w.total_return > 0);
      const perYear: Record<string, { trades: number; return: number; green: number; windows: number }> = {};
      for (const w of summary.windows) {
        if (w.total_trades === 0) continue;
        const year = w.start.slice(0, 4);
        if (!perYear[year]) perYear[year] = { trades: 0, return: 0, green: 0, windows: 0 };
        perYear[year].trades += w.total_trades;
        perYear[year].return += w.total_return;
        perYear[year].windows += 1;
        if (w.total_return > 0) perYear[year].green += 1;
      }
      const perYearFinal: Cell["per_year"] = {};
      for (const [y, v] of Object.entries(perYear)) {
        perYearFinal[y] = {
          trades: v.trades,
          return: Number(v.return.toFixed(0)),
          green_pct: Number(((v.green / v.windows) * 100).toFixed(0)),
          windows: v.windows,
        };
      }
      const cell: Cell = {
        rr,
        lookback,
        windows: summary.total_windows,
        windows_with_trades: traded.length,
        green_pct: traded.length ? Number(((green.length / traded.length) * 100).toFixed(1)) : 0,
        trades: summary.windows.reduce((s, w) => s + w.total_trades, 0),
        total_ret: Number(summary.windows.reduce((s, w) => s + w.total_return, 0).toFixed(0)),
        worst_dd: Number(Math.max(0, ...summary.windows.map((w) => w.max_drawdown)).toFixed(2)),
        dd_breaches_gt5: summary.windows.filter((w) => w.max_drawdown > 5).length,
        per_year: perYearFinal,
      };
      cells.push(cell);
      console.log(
        `rr=${rr} lb=${lookback}  trades=${cell.trades.toString().padStart(3)}  ret=$${cell.total_ret.toString().padStart(7)}  green=${cell.green_pct.toString().padStart(5)}%  worstDD=${cell.worst_dd}%  breaches>5%=${cell.dd_breaches_gt5}`
      );
    }
  }

  console.log("\n--- Sorted by total return ---");
  const sorted = [...cells].sort((a, b) => b.total_ret - a.total_ret);
  for (const c of sorted) {
    const ship = c.green_pct >= 60 && c.worst_dd <= 5 && c.dd_breaches_gt5 === 0 ? "  SHIP" : "      ";
    const proposed = c.rr === 3 && c.lookback === 4 ? " ← PROPOSED" : "";
    console.log(
      `${ship}  rr=${c.rr} lb=${c.lookback}  ret=$${c.total_ret.toString().padStart(7)}  green=${c.green_pct.toString().padStart(5)}%  worstDD=${c.worst_dd}%${proposed}`
    );
  }

  console.log("\n--- Per-year breakdown (return $) — rows by rr×lb, cols by year ---");
  const allYears = Array.from(new Set(cells.flatMap((c) => Object.keys(c.per_year)))).sort();
  console.log(`              ${allYears.map((y) => y.padStart(8)).join(" ")}`);
  for (const c of cells) {
    const row = allYears.map((y) => {
      const v = c.per_year[y];
      return v ? `$${v.return.toString().padStart(6)}` : "    -   ";
    });
    const tag = c.rr === 3 && c.lookback === 4 ? " ←prop" : "       ";
    console.log(`rr=${c.rr} lb=${c.lookback}${tag} ${row.join(" ")}`);
  }

  console.log("\n--- Per-year green % — rows by rr×lb, cols by year ---");
  console.log(`              ${allYears.map((y) => y.padStart(7)).join(" ")}`);
  for (const c of cells) {
    const row = allYears.map((y) => {
      const v = c.per_year[y];
      return v ? `${v.green_pct.toString().padStart(3)}/${v.windows}`.padStart(7) : "   -   ";
    });
    const tag = c.rr === 3 && c.lookback === 4 ? " ←prop" : "       ";
    console.log(`rr=${c.rr} lb=${c.lookback}${tag} ${row.join(" ")}`);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outPath = `scripts/sweep-fvg-dailybias-geometry-${stamp}.json`;
  writeFileSync(outPath, JSON.stringify({ cells }, null, 2));
  console.log(`\nSummary saved: ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
