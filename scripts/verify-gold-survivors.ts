/**
 * Clean re-verification of the 4 surviving Gold algos. Runs RR×lb grid
 * for each via direct runPortfolioBacktest calls. Reports top-return
 * cell among FTMO-eligible (positive + static DD < 10%) and a separate
 * top-return-with-WR-≥-40-floor cell.
 *
 * Trustworthy because it bypasses the phase1-sweep-library script
 * whose numbers diverged from direct backtests.
 */
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import { timeframeToInterval } from "../src/lib/market-data/interval";
import { runPortfolioBacktest } from "../src/lib/market-data/portfolio-backtest";
import { getCachedPrices } from "../src/lib/market-data/price-cache";
import type { BacktestTrade } from "../src/lib/market-data/types";
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
const LB_GRID = [3, 4, 5, 6, 8, 12];
const TARGETS = [
  "Library: Gold FVG-DailyBias-Long 4h",
  "Library: Gold FVG-Long 30m",
  "Library: Gold Coil-Breakout 4h",
  "Library: Gold Coil-Breakout 1h",
];

interface Cell {
  rr: number;
  lb: number;
  trades: number;
  total: number;
  sdd: number;
  pdd: number;
  wr: number;
}

function computeCell(rr: number, lb: number, trades: BacktestTrade[], capital: number): Cell {
  if (trades.length === 0) return { rr, lb, trades: 0, total: 0, sdd: 0, pdd: 0, wr: 0 };
  const sorted = [...trades].sort((a, b) => new Date(a.exit_date).getTime() - new Date(b.exit_date).getTime());
  let cum = 0, peak = 0, maxDd = 0, maxSdd = 0, wins = 0;
  for (const t of sorted) {
    cum += t.pnl;
    if (t.pnl > 0) wins++;
    if (cum > peak) peak = cum;
    const pdd = ((peak - cum) / capital) * 100;
    if (pdd > maxDd) maxDd = pdd;
    const sdd = cum < 0 ? (-cum / capital) * 100 : 0;
    if (sdd > maxSdd) maxSdd = sdd;
  }
  return { rr, lb, trades: sorted.length, total: Math.round(cum * 100) / 100, sdd: Math.round(maxSdd * 100) / 100, pdd: Math.round(maxDd * 100) / 100, wr: Math.round(wins / sorted.length * 1000) / 10 };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function verifyAlgo(supabase: any, name: string): Promise<void> {
  const algoRes = await supabase.from("algorithms").select("id, capital, rules").eq("name", name).single();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const algo = algoRes.data as any as { id: string; capital: number; rules: AlgorithmRules };
  const wl = await supabase.from("algorithm_watchlist").select("ticker").eq("algorithm_id", algo.id);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ticker = ((wl.data ?? []) as any[])[0]?.ticker?.toUpperCase() ?? "";
  const interval = timeframeToInterval(algo.rules.timeframe);
  const bars = await getCachedPrices(ticker, "full", interval);
  if (!bars) { console.log(`  ${name}: no bars`); return; }

  console.log(`\n===== ${name} (${ticker}, ${interval}, ${bars.length} bars) =====`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = algo.rules as any;
  const currentRr = r.take_profit?.value;
  const currentLb = r.stop_loss?.lookback;
  const ddThreshold = r.prop_firm?.max_drawdown ?? 10;

  const cells: Cell[] = [];
  for (const rr of RR_GRID) {
    for (const lb of LB_GRID) {
      const cloned = JSON.parse(JSON.stringify(algo.rules)) as AlgorithmRules;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (cloned as any).take_profit.value = rr;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (cloned as any).stop_loss.lookback = lb;
      const result = runPortfolioBacktest(cloned, new Map([[ticker, bars]]), algo.capital, []);
      cells.push(computeCell(rr, lb, result.trades, algo.capital));
    }
  }

  const current = cells.find((c) => c.rr === currentRr && c.lb === currentLb);
  console.log(`  CURRENT  RR=${currentRr} lb=${currentLb}: ${current ? `$${current.total} / ${current.trades}t / static ${current.sdd}% / peak-trough ${current.pdd}% / WR ${current.wr}%` : "not in grid"}`);

  // Top return — passes FTMO (static + positive)
  const ftmoEligible = cells.filter((c) => c.total > 0 && c.sdd < ddThreshold && c.trades > 0);
  ftmoEligible.sort((a, b) => b.total - a.total);
  if (ftmoEligible.length > 0) {
    const t = ftmoEligible[0];
    console.log(`  TOP RETURN (FTMO-safe, any WR):     RR=${t.rr} lb=${t.lb}: $${t.total} / ${t.trades}t / static ${t.sdd}% / peak-trough ${t.pdd}% / WR ${t.wr}%`);
  } else {
    console.log(`  TOP RETURN (FTMO-safe, any WR): none`);
  }

  // Top return — also passes WR ≥ 37% (operator-set floor)
  const wrFiltered = ftmoEligible.filter((c) => c.wr >= 37);
  if (wrFiltered.length > 0) {
    const t = wrFiltered[0];
    console.log(`  TOP RETURN (FTMO-safe, WR ≥ 37%):   RR=${t.rr} lb=${t.lb}: $${t.total} / ${t.trades}t / static ${t.sdd}% / peak-trough ${t.pdd}% / WR ${t.wr}%`);
  } else {
    console.log(`  TOP RETURN (FTMO-safe, WR ≥ 37%):   none — drop WR floor to find a winner`);
  }
}

async function main(): Promise<void> {
  console.log(`\n===== Gold survivors verification @ ${new Date().toISOString().slice(0, 16)} =====`);
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const supabase = createClient(url, key, { auth: { persistSession: false } });
  for (const name of TARGETS) await verifyAlgo(supabase, name);
}

void main();
