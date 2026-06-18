/**
 * Re-sweep Coil-Breakout 1h alone with the FTMO-correct engine to
 * verify which RR×lb cell is actually best.
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

function staticDd(trades: BacktestTrade[], capital: number): number {
  let cum = 0, maxStaticDd = 0;
  const sorted = [...trades].sort((a, b) => new Date(a.exit_date).getTime() - new Date(b.exit_date).getTime());
  for (const t of sorted) {
    cum += t.pnl;
    const sdd = cum < 0 ? (-cum / capital) * 100 : 0;
    if (sdd > maxStaticDd) maxStaticDd = sdd;
  }
  return maxStaticDd;
}

function peakDd(trades: BacktestTrade[], capital: number): number {
  let cum = 0, peak = 0, maxDd = 0;
  const sorted = [...trades].sort((a, b) => new Date(a.exit_date).getTime() - new Date(b.exit_date).getTime());
  for (const t of sorted) {
    cum += t.pnl;
    if (cum > peak) peak = cum;
    const dd = ((peak - cum) / capital) * 100;
    if (dd > maxDd) maxDd = dd;
  }
  return maxDd;
}

function winRate(trades: BacktestTrade[]): number {
  if (trades.length === 0) return 0;
  return (trades.filter((t) => t.pnl > 0).length / trades.length) * 100;
}

async function main(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const supabase = createClient(url, key, { auth: { persistSession: false } });

  const algoRes = await supabase.from("algorithms").select("id, capital, rules").eq("name", "Library: Gold Coil-Breakout 1h").single();
  const algo = algoRes.data as unknown as { id: string; capital: number; rules: AlgorithmRules };
  const ticker = "XAU/USD";
  const interval = timeframeToInterval(algo.rules.timeframe);
  const bars = await getCachedPrices(ticker, "full", interval);
  if (!bars) { console.error("no bars"); return; }

  console.log(`bars: ${bars.length}\n`);
  console.log("  RR    lb   trades   total     static  peakDd   WR%");
  console.log("  ----  ---  ------   -------   ------  ------  ----");
  let best = { rr: 0, lb: 0, total: -Infinity, trades: 0, sdd: 0, pdd: 0, wr: 0 };
  for (const rr of RR_GRID) {
    for (const lb of LB_GRID) {
      const cloned = JSON.parse(JSON.stringify(algo.rules)) as AlgorithmRules;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (cloned as any).take_profit.value = rr;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (cloned as any).stop_loss.lookback = lb;
      const result = runPortfolioBacktest(cloned, new Map([[ticker, bars]]), algo.capital, []);
      const total = result.trades.reduce((s, t) => s + t.pnl, 0);
      const sdd = staticDd(result.trades, algo.capital);
      const pdd = peakDd(result.trades, algo.capital);
      const wr = winRate(result.trades);
      const eligible = total > 0 && sdd < 10 && wr >= 40;
      const marker = eligible ? "✓" : " ";
      console.log(`  ${rr.toString().padStart(4)} ${lb.toString().padStart(4)} ${result.trades.length.toString().padStart(6)}  $${total.toFixed(0).padStart(7)}  ${sdd.toFixed(2).padStart(5)}%  ${pdd.toFixed(2).padStart(5)}%  ${wr.toFixed(0).padStart(3)}% ${marker}`);
      if (eligible && total > best.total) {
        best = { rr, lb, total, trades: result.trades.length, sdd, pdd, wr };
      }
    }
  }
  console.log(`\n  BEST eligible: RR=${best.rr} lb=${best.lb} → $${best.total.toFixed(0)} / ${best.trades} trades / static ${best.sdd.toFixed(2)}% / peak-trough ${best.pdd.toFixed(2)}% / WR ${best.wr.toFixed(0)}%`);
}

void main();
