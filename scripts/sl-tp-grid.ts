/**
 * SL/TP grid search using ATR-multiple stops — the parameter space
 * professional traders and algos actually use, instead of fixed
 * percentages of entry price (which would be wrong because volatility
 * varies regime-to-regime).
 *
 * For each live gold algo: runs SL ∈ {1.0, 1.5, 2.0, 2.5, 3.0} × ATR
 * crossed with TP ∈ {1.0, 2.0, 3.0, 4.0, 6.0, 8.0} × ATR (30 combos
 * per algo) against the full backtest corpus, plus the algo's current
 * (legacy fixed-%) configuration as a baseline. Reports the top 5 by
 * total return + the current row for comparison.
 *
 * Why ATR-multiple: SL placed beyond ~1.5-2× ATR(14) sits outside
 * normal noise; pros use this so the same logic adapts whether gold
 * is at $2,000 or $4,640. Fixed-% would put SL at different ATR
 * multiples in different regimes — searching that space is searching
 * a moving target.
 *
 * Note: the engine wires atr_multiple via portfolio-backtest's
 * tryOpenEntry which captures ATR ONCE at entry-bar and stores it on
 * the position. All subsequent distance calculations (trailing,
 * stagnant, exit-price detection) use that entry-time ATR. So the
 * grid's reported numbers reflect the same behaviour a live deploy
 * would produce.
 *
 * Usage:
 *   pnpm tsx scripts/sl-tp-grid.ts                  # all 4 algos
 *   ALGO_IDS=<id1>,<id2> pnpm tsx scripts/sl-tp-grid.ts
 */
import { readFileSync } from "fs";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { runPortfolioBacktest } from "../src/lib/market-data/portfolio-backtest";
import { fetchDailyPrices } from "../src/lib/market-data/prices";
import { timeframeToInterval } from "../src/lib/market-data/interval";
import type { BacktestTrade, PriceBar } from "../src/lib/market-data/types";
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

// SL multipliers cover tight scalping (1×ATR) through swing (3×ATR).
// TP multipliers span 1× (RR < 1, "scalp the chop") through 8× ("let
// the tail run"). RR ratios from 0.33 to 8.0 covered.
const SL_ATR_GRID = [1.0, 1.5, 2.0, 2.5, 3.0];
const TP_ATR_GRID = [1.0, 2.0, 3.0, 4.0, 6.0, 8.0];

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
  tp_hit_pct: number;
  sl_hit_pct: number;
  is_current: boolean;
}

/** Heuristic exit classification — same logic as inspect-algo, but
 *  parameterised by an explicit (slPct, tpPct) instead of reading from
 *  rules. Used only for the legacy fixed-% baseline row. */
function classifyHitFixedPct(
  t: BacktestTrade,
  slPct: number,
  tpPct: number
): "tp" | "sl" | "other" {
  if (t.entry_price <= 0) return "other";
  const ratio = t.exit_price / t.entry_price;
  const tpRatio = t.side === "long" ? 1 + tpPct / 100 : 1 - tpPct / 100;
  const slRatio = t.side === "long" ? 1 - slPct / 100 : 1 + slPct / 100;
  const TOL = 0.001;
  if (Math.abs(ratio - tpRatio) <= TOL) return "tp";
  if (Math.abs(ratio - slRatio) <= TOL) return "sl";
  return "other";
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

function runAtrCombo(
  baseRules: AlgorithmRules,
  pricesByTicker: Map<string, PriceBar[]>,
  capital: number,
  slMult: number,
  tpMult: number
): GridResult {
  const rules: AlgorithmRules = {
    ...baseRules,
    stop_loss: { type: "atr_multiple", value: slMult, atr_period: 14 },
    take_profit: { type: "atr_multiple", value: tpMult, atr_period: 14 },
  };
  const result = runPortfolioBacktest(rules, pricesByTicker, capital, [], null);
  // Per-trade hit classification is approximate for atr_multiple
  // (SL distance varies); tp_hit_pct here is a "wins via TP-like
  // exit" proxy and may underreport. Reported for symmetry with the
  // baseline row.
  const wins = result.trades.filter((t) => t.pnl > 0).length;
  const losses = result.trades.filter((t) => t.pnl <= 0).length;
  return {
    label: `SL ${slMult.toFixed(1)}×ATR / TP ${tpMult.toFixed(1)}×ATR (RR ${(tpMult / slMult).toFixed(2)}:1)`,
    trades: result.total_trades,
    win_rate: result.win_rate,
    total_return: result.total_return,
    max_drawdown: result.max_drawdown,
    tp_hit_pct: result.total_trades > 0 ? (wins / result.total_trades) * 100 : 0,
    sl_hit_pct: result.total_trades > 0 ? (losses / result.total_trades) * 100 : 0,
    is_current: false,
  };
}

function runCurrentBaseline(
  baseRules: AlgorithmRules,
  pricesByTicker: Map<string, PriceBar[]>,
  capital: number
): GridResult {
  const result = runPortfolioBacktest(baseRules, pricesByTicker, capital, [], null);
  const sl = baseRules.stop_loss;
  const tp = baseRules.take_profit;
  const slLabel =
    sl.type === "percentage"
      ? `SL ${sl.value}%`
      : sl.type === "atr_multiple"
        ? `SL ${sl.value}×ATR`
        : `SL ${sl.value}${sl.type}`;
  const tpLabel =
    tp.type === "percentage"
      ? `TP ${tp.value}%`
      : tp.type === "atr_multiple"
        ? `TP ${tp.value}×ATR`
        : `TP ${tp.value}${tp.type}`;
  let tpHits = 0;
  let slHits = 0;
  if (sl.type === "percentage" && tp.type === "percentage") {
    for (const t of result.trades) {
      const c = classifyHitFixedPct(t, sl.value, tp.value);
      if (c === "tp") tpHits++;
      else if (c === "sl") slHits++;
    }
  }
  return {
    label: `${slLabel} / ${tpLabel} [current]`,
    trades: result.total_trades,
    win_rate: result.win_rate,
    total_return: result.total_return,
    max_drawdown: result.max_drawdown,
    tp_hit_pct:
      result.total_trades > 0 ? (tpHits / result.total_trades) * 100 : 0,
    sl_hit_pct:
      result.total_trades > 0 ? (slHits / result.total_trades) * 100 : 0,
    is_current: true,
  };
}

function fmtRow(r: GridResult): string {
  const marker = r.is_current ? "*" : " ";
  return [
    `${marker} ${r.label.padEnd(46)}`,
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
      `  current rules: ${algoRow.rules.stop_loss.type}=${algoRow.rules.stop_loss.value}, ${algoRow.rules.take_profit.type}=${algoRow.rules.take_profit.value} · TF ${algoRow.rules.timeframe} · side ${algoRow.rules.side ?? "long"}`
    );

    const start = Date.now();
    const results: GridResult[] = [];
    results.push(runCurrentBaseline(algoRow.rules, pricesByTicker, capital));
    for (const sl of SL_ATR_GRID) {
      for (const tp of TP_ATR_GRID) {
        results.push(runAtrCombo(algoRow.rules, pricesByTicker, capital, sl, tp));
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
      console.log(`  (current config ranked in top 5 — already optimal)`);
    }
    console.log("");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
