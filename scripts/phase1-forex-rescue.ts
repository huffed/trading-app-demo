/**
 * Phase 1 forex rescue — sweeps RR × sl_pct on the percentage-SL
 * forex algos to see if any combination produces a survivable config.
 *
 * Usage:
 *   pnpm dlx tsx scripts/phase1-forex-rescue.ts
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

const RR_GRID = [1.5, 2, 2.5, 3, 4];
const SL_PCT_GRID = [0.15, 0.2, 0.3, 0.4, 0.5, 0.75];
const WINNER_MIN_WR = 37;

const TARGETS = [
  "Library: USD/JPY FVG-DailyBias-Long 4h",
  "Library: USD/JPY Coil-Breakout-Long 4h",
  "Library: USD/JPY sweep_reclaim-DailyBias-Long 4h",
  "Library: GBP/USD FVG-DailyBias-Long 4h",
  "Library: GBP/USD Dip-Buyer-Long 4h",
  "Library: EUR/USD FVG-DailyBias-Long 4h",
  "Library: EUR/USD Dip-Buyer-Long 4h",
];

interface CellResult {
  rr: number;
  sl_pct: number;
  total_return: number;
  max_drawdown: number;
  max_static_dd: number;
  trades: number;
  win_rate: number;
  calmar: number | null;
}

function computeCell(rr: number, sl_pct: number, trades: BacktestTrade[], capital: number): CellResult {
  if (trades.length === 0) {
    return { rr, sl_pct, total_return: 0, max_drawdown: 0, max_static_dd: 0, trades: 0, win_rate: 0, calmar: null };
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
    const staticDd = cum < 0 ? (-cum / capital) * 100 : 0;
    if (staticDd > maxStaticDd) maxStaticDd = staticDd;
  }
  return {
    rr,
    sl_pct,
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
    // FTMO static DD + return-priority per
    // [[feedback_winner_rule_return_within_ftmo]].
    (c) => c.trades > 0 && c.total_return > 0 && c.win_rate >= WINNER_MIN_WR && c.max_static_dd < ddThreshold
  );
  if (eligible.length === 0) return null;
  return eligible.reduce((best, c) => (c.total_return > best.total_return ? c : best));
}

function cloneRules(rules: AlgorithmRules, rr: number, sl_pct: number): AlgorithmRules {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = JSON.parse(JSON.stringify(rules)) as any;
  if (r.take_profit?.type === "rr_multiple") r.take_profit.value = rr;
  if (r.stop_loss?.type === "percentage") r.stop_loss.value = sl_pct;
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

async function main(): Promise<void> {
  console.log(`\n===== Forex rescue sweep @ ${new Date().toISOString().slice(0, 16)} =====`);
  console.log(`Grid: RR × sl_pct = ${RR_GRID.length} × ${SL_PCT_GRID.length} = ${RR_GRID.length * SL_PCT_GRID.length} cells\n`);

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const supabase = createClient(url, key, { auth: { persistSession: false } });

  const algoRes = await supabase
    .from("algorithms")
    .select("id, name, capital, rules")
    .in("name", TARGETS);
  if (algoRes.error) { console.error(algoRes.error.message); process.exit(1); }
  const algos = (algoRes.data ?? []) as unknown as { id: string; name: string; capital: number; rules: AlgorithmRules }[];

  for (const algo of algos) {
    process.stdout.write(`\n  ${algo.name} ... `);
    const wl = await supabase.from("algorithm_watchlist").select("ticker").eq("algorithm_id", algo.id);
    const ticker = ((wl.data ?? []) as { ticker: string }[])[0]?.ticker.toUpperCase() ?? "";
    const interval = timeframeToInterval(algo.rules.timeframe);
    const bars = await loadBars(ticker, interval);
    if (!bars) { console.log(`✗ no bars`); continue; }
    const prices = new Map([[ticker, bars]]);
    const cells: CellResult[] = [];
    for (const rr of RR_GRID) {
      for (const sl_pct of SL_PCT_GRID) {
        const rules = cloneRules(algo.rules, rr, sl_pct);
        const result = runPortfolioBacktest(rules, prices, algo.capital, []);
        cells.push(computeCell(rr, sl_pct, result.trades, algo.capital));
      }
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = algo.rules as any;
    const ddThreshold = r.prop_firm?.max_drawdown ?? 10;
    const currentRr = r.take_profit?.value;
    const currentSl = r.stop_loss?.value;
    const current = cells.find((c) => c.rr === currentRr && c.sl_pct === currentSl);
    const winner = pickWinner(cells, ddThreshold);
    console.log("");
    if (current) {
      console.log(`    CURRENT  RR=${current.rr} sl=${current.sl_pct}%: $${current.total_return.toFixed(0)} / DD ${current.max_drawdown.toFixed(2)}% / ${current.trades} trades / WR ${current.win_rate.toFixed(0)}%`);
    } else {
      console.log(`    CURRENT  RR=${currentRr} sl=${currentSl}% — not in grid (outside test range)`);
    }
    if (winner) {
      console.log(`    WINNER   RR=${winner.rr} sl=${winner.sl_pct}%: $${winner.total_return.toFixed(0)} / DD ${winner.max_drawdown.toFixed(2)}% / ${winner.trades} trades / WR ${winner.win_rate.toFixed(0)}% / Calmar ${winner.calmar?.toFixed(2) ?? "—"}`);
      const monthlyPct = (winner.total_return / algo.capital / 72) * 100;
      console.log(`    VERDICT  SALVAGEABLE — ${monthlyPct.toFixed(2)}%/month equivalent at \$${algo.capital.toLocaleString()} capital`);
    } else {
      console.log(`    WINNER   — none`);
      console.log(`    VERDICT  UNSALVAGEABLE — no cell passes DD < ${ddThreshold}% + WR ≥ ${WINNER_MIN_WR}% + positive`);
    }
  }
}

void main();
