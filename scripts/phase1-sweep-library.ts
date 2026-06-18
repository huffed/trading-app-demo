/**
 * Phase 1 sweep — runs the RR × lookback grid against all surviving +
 * failing library algos so the operator can see at a glance:
 *   - Survivors: is the current config on a plateau, or a lucky peak?
 *   - Failures: does any RR × lookback combination rescue them?
 *
 * Uses the same engine path as /algorithms/[id]/validate so results
 * mirror what the UI shows.
 *
 * Output: a per-algo table with current-config baseline + winner cell
 * + verdict (already-best / better-cell-exists / unsalvageable / NA).
 *
 * Usage:
 *   pnpm dlx tsx scripts/phase1-sweep-library.ts
 */
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import { timeframeToInterval } from "../src/lib/market-data/interval";
import { runPortfolioBacktest } from "../src/lib/market-data/portfolio-backtest";
import { getCachedPrices, savePricesToCache } from "../src/lib/market-data/price-cache";
import { fetchDailyPrices } from "../src/lib/market-data/prices";
import type { BacktestTrade, PriceBar } from "../src/lib/market-data/types";
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
  } catch {}
}

const RR_GRID = [1.5, 2, 2.5, 3, 4, 5];
const LOOKBACK_GRID = [3, 4, 5, 6, 8, 12];
const WINNER_MIN_WR = 37;

const SURVIVOR_NAMES = [
  "Library: Gold FVG-DailyBias-Long 4h",
  "Library: Gold FVG-Long 30m",
  "Library: Gold Coil-Breakout 4h",
  "Library: Gold Coil-Breakout 1h",
];

const FAILURE_NAMES = [
  "Library: USD/JPY FVG-DailyBias-Long 4h",
  "Library: USD/JPY Coil-Breakout-Long 4h",
  "Library: USD/JPY Dip-Buyer-Long 4h",
  "Library: USD/JPY sweep_reclaim-DailyBias-Long 4h",
  "Library: GBP/USD FVG-DailyBias-Long 4h",
  "Library: GBP/USD Dip-Buyer-Long 4h",
  "Library: EUR/USD FVG-DailyBias-Long 4h",
  "Library: EUR/USD Dip-Buyer-Long 4h",
  "Library: Gold OTE-Long 4h",
  "Library: Gold Dip-Buyer 4h",
  "Library: Gold sweep_reclaim-DailyBias-Long 4h",
];

interface CellResult {
  rr: number;
  lookback: number;
  total_return: number;
  /** Peak-to-trough trailing drawdown — RISK STAT, not used for FTMO
   *  eligibility (operator's FTMO uses static-from-start). */
  max_drawdown: number;
  /** Static drawdown = max(0, (capital - equity_at_step) / capital × 100)
   *  at each step. This IS the FTMO breach metric. */
  max_static_dd: number;
  trades: number;
  win_rate: number;
  calmar: number | null;
}

function computeCell(rr: number, lookback: number, trades: BacktestTrade[], capital: number): CellResult {
  if (trades.length === 0) {
    return { rr, lookback, total_return: 0, max_drawdown: 0, max_static_dd: 0, trades: 0, win_rate: 0, calmar: null };
  }
  const sorted = [...trades].sort(
    (a, b) => new Date(a.exit_date).getTime() - new Date(b.exit_date).getTime()
  );
  let cum = 0, peak = 0, maxDd = 0, maxStaticDd = 0, wins = 0;
  for (const t of sorted) {
    cum += t.pnl;
    if (t.pnl > 0) wins++;
    if (cum > peak) peak = cum;
    const dd = ((peak - cum) / capital) * 100;
    if (dd > maxDd) maxDd = dd;
    // Static DD only counts when cumulative pnl is negative (equity
    // below starting balance). This is the actual FTMO breach metric.
    const staticDd = cum < 0 ? (-cum / capital) * 100 : 0;
    if (staticDd > maxStaticDd) maxStaticDd = staticDd;
  }
  return {
    rr,
    lookback,
    total_return: Math.round(cum * 100) / 100,
    max_drawdown: Math.round(maxDd * 100) / 100,
    max_static_dd: Math.round(maxStaticDd * 100) / 100,
    trades: sorted.length,
    win_rate: Math.round((wins / sorted.length) * 1000) / 10,
    calmar: maxDd > 0 ? Math.round((cum / maxDd) * 100) / 100 : null,
  };
}

function pickWinner(cells: CellResult[], ddThreshold: number): CellResult | null {
  const eligible = cells.filter(
    // FTMO eligibility: filter on STATIC DD (the real breach metric),
    // not peak-to-trough. Rank by total_return per
    // [[feedback_winner_rule_return_within_ftmo]].
    (c) => c.trades > 0 && c.total_return > 0 && c.win_rate >= WINNER_MIN_WR && c.max_static_dd < ddThreshold
  );
  if (eligible.length === 0) return null;
  return eligible.reduce((best, c) => (c.total_return > best.total_return ? c : best));
}

function cloneRules(rules: AlgorithmRules, rr: number, lookback: number): AlgorithmRules {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = JSON.parse(JSON.stringify(rules)) as any;
  if (r.take_profit?.type === "rr_multiple") r.take_profit.value = rr;
  if (r.stop_loss?.type === "swing_anchor") r.stop_loss.lookback = lookback;
  return r as AlgorithmRules;
}

async function loadBars(
  ticker: string,
  interval: ReturnType<typeof timeframeToInterval>
): Promise<PriceBar[] | null> {
  let prices = await getCachedPrices(ticker, "full", interval);
  if (!prices) {
    try {
      prices = await fetchDailyPrices(ticker, "full", interval);
      savePricesToCache(ticker, "full", prices, interval).catch(() => {});
    } catch {
      return null;
    }
  }
  return prices && prices.length >= 30 ? prices : null;
}

interface AlgoRow {
  id: string;
  name: string;
  capital: number;
  rules: AlgorithmRules;
  ticker: string;
}

async function sweepAlgo(algo: AlgoRow): Promise<{ cells: CellResult[]; current: CellResult; winner: CellResult | null; ddThreshold: number; slType: string; tpType: string }> {
  const interval = timeframeToInterval(algo.rules.timeframe);
  const bars = await loadBars(algo.ticker, interval);
  if (!bars) throw new Error(`No bars for ${algo.ticker} ${interval}`);
  const prices = new Map([[algo.ticker, bars]]);
  const cells: CellResult[] = [];
  for (const rr of RR_GRID) {
    for (const lookback of LOOKBACK_GRID) {
      const rules = cloneRules(algo.rules, rr, lookback);
      const result = runPortfolioBacktest(rules, prices, algo.capital, []);
      cells.push(computeCell(rr, lookback, result.trades, algo.capital));
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = algo.rules as any;
  const ddThreshold = r.prop_firm?.max_drawdown ?? 10;
  const currentRr = r.take_profit?.value ?? 0;
  const currentLb = r.stop_loss?.lookback ?? 0;
  const current: CellResult = cells.find((c) => c.rr === currentRr && c.lookback === currentLb)
    ?? { rr: currentRr, lookback: currentLb, total_return: NaN, max_drawdown: NaN, max_static_dd: NaN, trades: 0, win_rate: 0, calmar: null };
  const winner = pickWinner(cells, ddThreshold);
  return { cells, current, winner, ddThreshold, slType: r.stop_loss?.type ?? "?", tpType: r.take_profit?.type ?? "?" };
}

function verdict(current: CellResult, winner: CellResult | null, slType: string): string {
  if (slType !== "swing_anchor") return "N/A — non-swing_anchor SL (lookback axis doesn't apply)";
  if (!winner) return "UNSALVAGEABLE — no cell survives DD + WR ≥ 40% + positive return";
  if (winner.rr === current.rr && winner.lookback === current.lookback) return "PLATEAU — already on the best cell";
  const improvement = winner.total_return - current.total_return;
  return `BETTER CELL EXISTS — RR=${winner.rr} lb=${winner.lookback} (+$${improvement.toFixed(0)} vs current)`;
}

async function main(): Promise<void> {
  console.log(`\n===== Phase 1 sweep @ ${new Date().toISOString().slice(0, 16)} =====`);
  console.log(`Grid: RR × lookback = ${RR_GRID.length} × ${LOOKBACK_GRID.length} = ${RR_GRID.length * LOOKBACK_GRID.length} cells\n`);

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const supabase = createClient(url, key, { auth: { persistSession: false } });

  const names = [...SURVIVOR_NAMES, ...FAILURE_NAMES];
  const algoRes = await supabase
    .from("algorithms")
    .select("id, name, capital, rules")
    .in("name", names);
  if (algoRes.error) { console.error(algoRes.error.message); process.exit(1); }
  const algoMap = new Map<string, AlgoRow>();
  for (const a of (algoRes.data ?? []) as unknown as Omit<AlgoRow, "ticker">[]) {
    const wl = await supabase.from("algorithm_watchlist").select("ticker").eq("algorithm_id", a.id);
    const ticker = ((wl.data ?? []) as { ticker: string }[])[0]?.ticker.toUpperCase() ?? "";
    algoMap.set(a.name, { ...a, ticker });
  }

  for (const section of [
    { title: "SURVIVORS (sanity / plateau check)", names: SURVIVOR_NAMES },
    { title: "FAILURES (rescue check)", names: FAILURE_NAMES },
  ]) {
    console.log(`\n===== ${section.title} =====`);
    for (const name of section.names) {
      const algo = algoMap.get(name);
      if (!algo) { console.log(`  ⚠ ${name} — not in algorithms table`); continue; }
      process.stdout.write(`  ${name} ... `);
      try {
        const { current, winner, ddThreshold, slType, tpType } = await sweepAlgo(algo);
        console.log("");
        console.log(`    SL: ${slType}  TP: ${tpType}  prop_firm.max_drawdown: ${ddThreshold}%`);
        console.log(`    CURRENT  RR=${current.rr} lb=${current.lookback}: $${current.total_return.toFixed(0)} / static DD ${current.max_static_dd.toFixed(2)}% / peak-trough ${current.max_drawdown.toFixed(2)}% / ${current.trades} trades / WR ${current.win_rate.toFixed(0)}% / Calmar ${current.calmar?.toFixed(2) ?? "—"}`);
        if (winner) {
          console.log(`    WINNER   RR=${winner.rr} lb=${winner.lookback}: $${winner.total_return.toFixed(0)} / static DD ${winner.max_static_dd.toFixed(2)}% / peak-trough ${winner.max_drawdown.toFixed(2)}% / ${winner.trades} trades / WR ${winner.win_rate.toFixed(0)}% / Calmar ${winner.calmar?.toFixed(2) ?? "—"}`);
        } else {
          console.log(`    WINNER   — none (no cell passes FTMO static DD + WR ≥ 40% + positive)`);
        }
        console.log(`    VERDICT  ${verdict(current, winner, slType)}\n`);
      } catch (e) {
        console.log(`✗ ${e instanceof Error ? e.message : "error"}`);
      }
    }
  }
}

void main();
