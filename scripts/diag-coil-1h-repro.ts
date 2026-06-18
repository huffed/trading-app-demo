/**
 * Reproduce Coil-Breakout 1h discrepancy: phase1 sweep said RR=4 lb=6
 * produces 16 trades / $29501; backfill produces 80 trades / $12435 for
 * the same config. Run the backtest 3 times back-to-back to check for
 * non-determinism or state-pollution.
 */
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import { timeframeToInterval } from "../src/lib/market-data/interval";
import { runPortfolioBacktest } from "../src/lib/market-data/portfolio-backtest";
import { getCachedPrices } from "../src/lib/market-data/price-cache";
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

  console.log(`bars: ${bars.length}, first=${bars[0].date}, last=${bars[bars.length - 1].date}`);

  // Run 3 times with current rules
  for (let i = 0; i < 3; i++) {
    const result = runPortfolioBacktest(algo.rules, new Map([[ticker, bars]]), algo.capital, []);
    console.log(`Run ${i + 1}: ${result.trades.length} trades, total $${result.trades.reduce((s, t) => s + t.pnl, 0).toFixed(2)}`);
  }

  // Run 3 times with a freshly-cloned rules (simulating what the sweep does)
  for (let i = 0; i < 3; i++) {
    const cloned = JSON.parse(JSON.stringify(algo.rules)) as AlgorithmRules;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (cloned as any).take_profit.value = 4;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (cloned as any).stop_loss.lookback = 6;
    const result = runPortfolioBacktest(cloned, new Map([[ticker, bars]]), algo.capital, []);
    console.log(`Cloned run ${i + 1}: ${result.trades.length} trades, total $${result.trades.reduce((s, t) => s + t.pnl, 0).toFixed(2)}`);
  }
}

void main();
