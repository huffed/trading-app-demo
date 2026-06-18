/**
 * Diagnostic — verify the engine's DD rule diverges from FTMO standard.
 *
 * Engine: `(peakEquity - currentEquity) / capital` — peak-to-trough
 * trailing, halts whenever ratio >= 10%.
 *
 * FTMO standard: floor at `capital × (1 - max_drawdown_pct/100)` —
 * halts whenever equity drops below the floor. Once profit grows the
 * floor doesn't trail; only the absolute equity vs floor matters.
 *
 * This script:
 *   1. Runs USD/JPY FVG-DailyBias-Long 4h with prop_firm STRIPPED so
 *      the engine doesn't halt early (gives the full hypothetical
 *      trade list).
 *   2. Walks the equity curve chronologically.
 *   3. Reports the first bar where engine would halt (peak-to-trough
 *      DD >= 10%) and the equity at that moment.
 *   4. Compares to FTMO static floor: at that moment, was equity
 *      below $90K? If not, engine was wrong.
 *   5. Continues past the engine's halt point — does FTMO floor ever
 *      actually get breached?
 *   6. Reports each rule's final verdict + total return.
 *
 * Usage:
 *   pnpm dlx tsx scripts/diag-ftmo-dd-rule.ts
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

const ALGO = process.env.ALGO ?? "Library: USD/JPY FVG-DailyBias-Long 4h";
const MAX_DD_PCT = 10;

async function loadBars(ticker: string, interval: ReturnType<typeof timeframeToInterval>): Promise<PriceBar[] | null> {
  let prices = await getCachedPrices(ticker, "full", interval);
  if (!prices) {
    try {
      prices = await fetchDailyPrices(ticker, "full", interval);
      savePricesToCache(ticker, "full", prices, interval).catch(() => {});
    } catch { return null; }
  }
  return prices && prices.length >= 30 ? prices : null;
}

async function main(): Promise<void> {
  console.log(`\n===== FTMO DD rule diagnostic: ${ALGO} =====\n`);

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const supabase = createClient(url, key, { auth: { persistSession: false } });

  const algoRes = await supabase.from("algorithms").select("id, capital, rules").eq("name", ALGO).single();
  if (algoRes.error) { console.error(algoRes.error.message); process.exit(1); }
  const algo = algoRes.data as unknown as { id: string; capital: number; rules: AlgorithmRules };
  const wl = await supabase.from("algorithm_watchlist").select("ticker").eq("algorithm_id", algo.id);
  const ticker = ((wl.data ?? []) as { ticker: string }[])[0]?.ticker.toUpperCase() ?? "";
  const interval = timeframeToInterval(algo.rules.timeframe);
  const bars = await loadBars(ticker, interval);
  if (!bars) { console.error(`No bars for ${ticker} ${interval}`); process.exit(1); }

  const capital = algo.capital;
  const floor = capital * (1 - MAX_DD_PCT / 100);

  // Strip prop_firm so the engine doesn't halt early.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const unrestrictedRules: AlgorithmRules = { ...(algo.rules as any), prop_firm: undefined };
  const result = runPortfolioBacktest(unrestrictedRules, new Map([[ticker, bars]]), capital, []);
  const trades: BacktestTrade[] = [...result.trades].sort(
    (a, b) => new Date(a.exit_date).getTime() - new Date(b.exit_date).getTime()
  );

  console.log(`Capital:       $${capital.toLocaleString()}`);
  console.log(`FTMO floor:    $${floor.toLocaleString()} (= ${capital.toLocaleString()} × ${(1 - MAX_DD_PCT/100).toFixed(2)})`);
  console.log(`Trades total:  ${trades.length} (full corpus, no engine halt)\n`);

  let cum = 0;
  let peakEquity = capital;
  let engineHalted = false;
  let engineHaltedAtTradeIdx = -1;
  let engineHaltedEquity = 0;
  let ftmoBreached = false;
  let ftmoBreachedAtTradeIdx = -1;
  let worstPeakToTroughDdPct = 0;
  let lowestEquity = capital;

  for (let i = 0; i < trades.length; i++) {
    const t = trades[i];
    cum += t.pnl;
    const equity = capital + cum;
    if (equity > peakEquity) peakEquity = equity;
    const peakToTroughDdPct = ((peakEquity - equity) / capital) * 100;
    if (peakToTroughDdPct > worstPeakToTroughDdPct) worstPeakToTroughDdPct = peakToTroughDdPct;
    if (equity < lowestEquity) lowestEquity = equity;

    // Engine's halt check
    if (!engineHalted && peakToTroughDdPct >= MAX_DD_PCT) {
      engineHalted = true;
      engineHaltedAtTradeIdx = i;
      engineHaltedEquity = equity;
      const wouldFtmoBust = equity < floor;
      console.log(`>>> ENGINE HALT at trade ${i + 1}/${trades.length} (${t.exit_date.slice(0, 10)})`);
      console.log(`    equity        = $${equity.toFixed(2)}`);
      console.log(`    peak so far   = $${peakEquity.toFixed(2)}`);
      console.log(`    peak-to-trough = $${(peakEquity - equity).toFixed(2)} = ${peakToTroughDdPct.toFixed(2)}%`);
      console.log(`    FTMO floor    = $${floor.toFixed(2)}`);
      console.log(`    Would FTMO also bust here? ${wouldFtmoBust ? "YES — same verdict" : `NO — equity $${(equity - floor).toFixed(2)} above floor`}`);
      console.log("");
    }

    // FTMO static check
    if (!ftmoBreached && equity < floor) {
      ftmoBreached = true;
      ftmoBreachedAtTradeIdx = i;
      console.log(`>>> FTMO BREACH at trade ${i + 1}/${trades.length} (${t.exit_date.slice(0, 10)})`);
      console.log(`    equity        = $${equity.toFixed(2)} (below floor $${floor.toFixed(2)})`);
      console.log(`    loss vs start = $${(capital - equity).toFixed(2)} = ${((capital - equity) / capital * 100).toFixed(2)}%`);
      console.log("");
    }
  }

  const finalEquity = capital + cum;
  console.log(`\n===== FINAL =====`);
  console.log(`Final equity:           $${finalEquity.toFixed(2)} (${cum >= 0 ? "+" : ""}$${cum.toFixed(2)} = ${(cum / capital * 100).toFixed(2)}%)`);
  console.log(`Peak equity:            $${peakEquity.toFixed(2)} (${((peakEquity - capital) / capital * 100).toFixed(2)}% above start)`);
  console.log(`Lowest equity:          $${lowestEquity.toFixed(2)} (${((lowestEquity - capital) / capital * 100).toFixed(2)}% vs start)`);
  console.log(`Worst peak-to-trough:   ${worstPeakToTroughDdPct.toFixed(2)}%`);
  console.log(`Distance from floor:    $${(lowestEquity - floor).toFixed(2)} ${lowestEquity >= floor ? "(NEVER BREACHED FTMO)" : "(BREACHED FTMO)"}`);
  console.log("");
  console.log(`ENGINE verdict:  ${engineHalted ? `HALTED at trade ${engineHaltedAtTradeIdx + 1}, equity $${engineHaltedEquity.toFixed(2)}` : "did not halt"}`);
  console.log(`FTMO   verdict:  ${ftmoBreached ? `BREACHED at trade ${ftmoBreachedAtTradeIdx + 1}` : "would NEVER have breached FTMO"}`);
  if (engineHalted && !ftmoBreached) {
    console.log(`\n*** BUG CONFIRMED ***`);
    console.log(`The engine halted at trade ${engineHaltedAtTradeIdx + 1} where equity was $${engineHaltedEquity.toFixed(2)}.`);
    console.log(`FTMO's static $${floor.toFixed(2)} floor was never breached across all ${trades.length} trades.`);
    console.log(`The algo's 'unsalvageable' verdict was a false failure of the engine's stricter rule.`);
  } else if (engineHalted && ftmoBreached && ftmoBreachedAtTradeIdx > engineHaltedAtTradeIdx) {
    console.log(`\n*** ENGINE OVER-EAGER ***`);
    console.log(`The engine halted at trade ${engineHaltedAtTradeIdx + 1} but FTMO would not have busted until trade ${ftmoBreachedAtTradeIdx + 1}.`);
    console.log(`Algo would have had ${ftmoBreachedAtTradeIdx - engineHaltedAtTradeIdx} more trades to recover or eventually bust.`);
  } else {
    console.log(`\nEngine and FTMO verdicts align.`);
  }
}

void main();
