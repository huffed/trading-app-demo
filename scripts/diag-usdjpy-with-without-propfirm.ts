/**
 * Trace USD/JPY FVG-DailyBias-Long 4h:
 *   - With current prop_firm (FTMO-correct engine): what halts it?
 *   - Without prop_firm: full corpus reference
 *
 * Test both to see exactly where prop_firm enforcement intervenes
 * beyond the static DD rule we just fixed.
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

  const algoRes = await supabase.from("algorithms").select("id, capital, rules").eq("name", "Library: USD/JPY FVG-DailyBias-Long 4h").single();
  const algo = algoRes.data as unknown as { id: string; capital: number; rules: AlgorithmRules };
  const ticker = "USD/JPY";
  const interval = timeframeToInterval(algo.rules.timeframe);
  const bars = await getCachedPrices(ticker, "full", interval);
  if (!bars) { console.error("no bars"); return; }

  console.log(`bars: ${bars.length}, first=${bars[0].date}, last=${bars[bars.length - 1].date}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  console.log(`prop_firm: ${JSON.stringify((algo.rules as any).prop_firm)}`);

  // Run 1: WITH current prop_firm (FTMO-correct engine)
  const withResult = runPortfolioBacktest(algo.rules, new Map([[ticker, bars]]), algo.capital, []);
  const withTotal = withResult.trades.reduce((s, t) => s + t.pnl, 0);
  const lastWithTrade = withResult.trades.at(-1);
  console.log(`\nWITH prop_firm: ${withResult.trades.length} trades, total $${withTotal.toFixed(2)}`);
  if (lastWithTrade) console.log(`  Last trade exit: ${lastWithTrade.exit_date}`);

  // Run 2: WITHOUT prop_firm
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const unrestricted: AlgorithmRules = { ...(algo.rules as any), prop_firm: undefined };
  const withoutResult = runPortfolioBacktest(unrestricted, new Map([[ticker, bars]]), algo.capital, []);
  const withoutTotal = withoutResult.trades.reduce((s, t) => s + t.pnl, 0);
  const lastWithoutTrade = withoutResult.trades.at(-1);
  console.log(`\nWITHOUT prop_firm: ${withoutResult.trades.length} trades, total $${withoutTotal.toFixed(2)}`);
  if (lastWithoutTrade) console.log(`  Last trade exit: ${lastWithoutTrade.exit_date}`);

  // Trace equity for the WITH run to find what stopped it
  let cum = 0, peak = 0;
  let lowestEquity = algo.capital;
  for (const t of withResult.trades) {
    cum += t.pnl;
    const equity = algo.capital + cum;
    if (equity > peak + algo.capital) peak = equity - algo.capital;
    if (equity < lowestEquity) lowestEquity = equity;
  }
  console.log(`\nWITH run trace: peak gain $${peak.toFixed(2)}, lowest equity $${lowestEquity.toFixed(2)} (floor $${(algo.capital * 0.9).toFixed(2)})`);
  console.log(`Static DD never breached? ${lowestEquity >= algo.capital * 0.9 ? "YES" : "NO"}`);

  // If WITH stopped early, what's the gap?
  if (withResult.trades.length < withoutResult.trades.length) {
    const gap = withoutResult.trades.length - withResult.trades.length;
    console.log(`\n>>> PROP_FIRM STOPPED IT EARLY: ${gap} trades skipped. The static DD wasn't breached. Something ELSE in prop_firm enforcement is halting.`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pf = (algo.rules as any).prop_firm;
    console.log(`Suspects: daily_loss_limit=${pf.daily_loss_limit}, max_consecutive_losses=${pf.max_consecutive_losses}, consecutive_loss_daily_halt=${pf.consecutive_loss_daily_halt}`);
  }
}

void main();
