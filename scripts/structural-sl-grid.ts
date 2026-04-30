/**
 * Structural SL/TP grid — tests swing-anchored stops with RR-multiple
 * targets, the placement methodology used by professional manual
 * traders (ICT/SMC) and the natural fit for our pattern-driven gold
 * algos. Anchors SL beyond the last N-bar swing low/high (with a small
 * ATR buffer to escape sweeps), then TP at fixed RR.
 *
 * Why this exists: the prior fixed-% and ATR-multiple grids both
 * showed our current configs were already optimal in their respective
 * spaces. Structural placement is a different parameter family — SL
 * distance varies per trade based on actual price structure, not on
 * a fixed unit relative to entry price or volatility.
 *
 * Grid: SL lookback ∈ {3, 5, 8, 13, 21} × buffer ∈ {0, 0.25, 0.5}×ATR
 *       TP RR ∈ {1.5, 2.0, 3.0, 4.0}
 * = 5 × 3 × 4 = 60 combos per algo, plus the algo's current config
 * baseline.
 *
 * Usage:
 *   pnpm tsx scripts/structural-sl-grid.ts                  # all 4 algos
 *   ALGO_IDS=<id1>,<id2> pnpm tsx scripts/structural-sl-grid.ts
 */
import { readFileSync } from "fs";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { runPortfolioBacktest } from "../src/lib/market-data/portfolio-backtest";
import { fetchDailyPrices } from "../src/lib/market-data/prices";
import { timeframeToInterval } from "../src/lib/market-data/interval";
import type { PriceBar } from "../src/lib/market-data/types";
import type { AlgorithmRules } from "../src/types/algorithm";

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

const DEFAULT_ALGOS = [
  { label: "B (15m short)", id: "65a7fbfe-89a3-435e-806b-8f24a6b4ed68" },
  { label: "C (1h ICT long)", id: "07ca6b2a-ac56-4cfe-86ca-4194c644c52a" },
  { label: "D (1h momentum)", id: "52cc7bc7-2a29-4062-b610-e9c34548f8a2" },
  { label: "E (1h engulf)", id: "f5215d2e-48cb-4204-aba1-7ff8f13c38f8" },
];

const LOOKBACK_GRID = [3, 5, 8, 13, 21];
const BUFFER_GRID = [0, 0.25, 0.5];
const RR_GRID = [1.5, 2.0, 3.0, 4.0];

interface AlgoRow {
  id: string;
  name: string;
  capital: number;
  rules: AlgorithmRules;
}

interface WatchlistRow {
  ticker: string;
}

interface GridResult {
  label: string;
  trades: number;
  win_rate: number;
  total_return: number;
  max_drawdown: number;
  is_current: boolean;
}

async function loadAlgo(
  supabase: SupabaseClient,
  algoId: string
): Promise<{ algoRow: AlgoRow; pricesByTicker: Map<string, PriceBar[]> }> {
  const { data: algo, error: algoErr } = await supabase
    .from("algorithms")
    .select("id, name, capital, rules")
    .eq("id", algoId)
    .single();
  if (algoErr || !algo) throw new Error(`Could not fetch algo ${algoId}`);
  const algoRow = algo as unknown as AlgoRow;

  const { data: watchlist } = await supabase
    .from("algorithm_watchlist")
    .select("ticker")
    .eq("algorithm_id", algoId);
  const tickers = ((watchlist ?? []) as WatchlistRow[]).map((w) => w.ticker);

  const interval = timeframeToInterval(algoRow.rules.timeframe);
  const pricesByTicker = new Map<string, PriceBar[]>();
  for (const ticker of tickers) {
    const bars = await fetchDailyPrices(ticker, "full", interval);
    pricesByTicker.set(ticker, bars);
  }
  return { algoRow, pricesByTicker };
}

function runStructuralCombo(
  baseRules: AlgorithmRules,
  pricesByTicker: Map<string, PriceBar[]>,
  capital: number,
  lookback: number,
  bufferAtr: number,
  rr: number
): GridResult {
  const rules: AlgorithmRules = {
    ...baseRules,
    stop_loss: {
      type: "swing_anchor",
      value: bufferAtr,
      lookback,
      atr_period: 14,
    },
    take_profit: { type: "rr_multiple", value: rr },
  };
  const result = runPortfolioBacktest(rules, pricesByTicker, capital, []);
  return {
    label: `swing(${lookback}) +${bufferAtr.toFixed(2)}×ATR · TP RR ${rr.toFixed(1)}:1`,
    trades: result.total_trades,
    win_rate: result.win_rate,
    total_return: result.total_return,
    max_drawdown: result.max_drawdown,
    is_current: false,
  };
}

function runCurrentBaseline(
  baseRules: AlgorithmRules,
  pricesByTicker: Map<string, PriceBar[]>,
  capital: number
): GridResult {
  const result = runPortfolioBacktest(baseRules, pricesByTicker, capital, []);
  const sl = baseRules.stop_loss;
  const tp = baseRules.take_profit;
  const slLabel = sl.type === "percentage" ? `SL ${sl.value}%` : `SL ${sl.value} ${sl.type}`;
  const tpLabel = tp.type === "percentage" ? `TP ${tp.value}%` : `TP ${tp.value} ${tp.type}`;
  return {
    label: `${slLabel} / ${tpLabel} [current]`,
    trades: result.total_trades,
    win_rate: result.win_rate,
    total_return: result.total_return,
    max_drawdown: result.max_drawdown,
    is_current: true,
  };
}

function fmtRow(r: GridResult): string {
  const marker = r.is_current ? "*" : " ";
  return [
    `${marker} ${r.label.padEnd(48)}`,
    `${String(r.trades).padStart(3)}t`,
    `WR ${r.win_rate.toFixed(1).padStart(5)}%`,
    `$${r.total_return.toFixed(0).padStart(7)}`,
    `DD ${r.max_drawdown.toFixed(2).padStart(5)}%`,
  ].join("  ");
}

async function main(): Promise<void> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY required");
  }
  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const algoFilter = process.env.ALGO_IDS?.split(",").map((s) => s.trim());
  const algos = algoFilter
    ? DEFAULT_ALGOS.filter((a) => algoFilter.includes(a.id))
    : DEFAULT_ALGOS;

  for (const algoMeta of algos) {
    console.log(`=== Algo ${algoMeta.label} ===`);
    const { algoRow, pricesByTicker } = await loadAlgo(supabase, algoMeta.id);
    const capital = Number(algoRow.capital);
    console.log(
      `  current: ${algoRow.rules.stop_loss.type}=${algoRow.rules.stop_loss.value}, ${algoRow.rules.take_profit.type}=${algoRow.rules.take_profit.value} · TF ${algoRow.rules.timeframe} · side ${algoRow.rules.side ?? "long"}`
    );

    const start = Date.now();
    const results: GridResult[] = [];
    results.push(runCurrentBaseline(algoRow.rules, pricesByTicker, capital));
    for (const lookback of LOOKBACK_GRID) {
      for (const buffer of BUFFER_GRID) {
        for (const rr of RR_GRID) {
          results.push(
            runStructuralCombo(algoRow.rules, pricesByTicker, capital, lookback, buffer, rr)
          );
        }
      }
    }
    const duration = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`  ran ${results.length} backtests in ${duration}s\n`);

    const sorted = [...results].sort((a, b) => b.total_return - a.total_return);
    console.log(`  Top 5 by total return:`);
    for (const r of sorted.slice(0, 5)) console.log(`    ${fmtRow(r)}`);

    const current = results.find((r) => r.is_current);
    if (current && !sorted.slice(0, 5).includes(current)) {
      const rank = sorted.indexOf(current) + 1;
      console.log(`  Current config (rank ${rank}/${results.length}):`);
      console.log(`    ${fmtRow(current)}`);
    } else if (current) {
      console.log(`  (current config ranked in top 5 — no structural alternative outperforms)`);
    }
    console.log("");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
