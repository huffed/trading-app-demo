/**
 * Backfill backtest_trades for every condition-based algorithm.
 *
 * For each non-LLM-trader algo with a non-empty watchlist:
 *   - Skip if backtest_trades already has rows for this algo (unless
 *     FORCE=1).
 *   - Load full-history bars per watchlist ticker from price_cache
 *     (falling back to OANDA via fetchDailyPrices on miss).
 *   - Fetch economic calendar if rules.news_veto is on.
 *   - Run runPortfolioBacktest.
 *   - DELETE any existing backtest_trades rows for the algo.
 *   - INSERT the fresh trades.
 *
 * LLM-trader algos are intentionally skipped — per-bar LLM calls would
 * burn the monthly budget. They stay on the harness scripts for
 * validation.
 *
 * Idempotent — re-running without FORCE skips already-populated algos.
 *
 * Usage:
 *   DRY_RUN=1 pnpm dlx tsx scripts/backfill-backtest-trades.ts   # default
 *   APPLY=1   pnpm dlx tsx scripts/backfill-backtest-trades.ts   # write
 *   APPLY=1 FORCE=1 ...                                          # overwrite existing
 *   APPLY=1 ONLY="Library: Gold Coil-Breakout 4h" ...            # one algo
 */
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import { fetchEconomicCalendar } from "../src/lib/market-data/economic-calendar";
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
  } catch {
    /* ignore */
  }
}

const APPLY = process.env.APPLY === "1";
const FORCE = process.env.FORCE === "1";
const ONLY = process.env.ONLY ?? "";

interface AlgoRow {
  id: string;
  user_id: string;
  name: string;
  capital: number;
  rules: AlgorithmRules;
}

async function loadPricesForTickers(
  tickers: string[],
  interval: ReturnType<typeof timeframeToInterval>
): Promise<Map<string, PriceBar[]>> {
  const out = new Map<string, PriceBar[]>();
  for (const ticker of tickers) {
    let prices = await getCachedPrices(ticker, "full", interval);
    if (!prices) {
      try {
        prices = await fetchDailyPrices(ticker, "full", interval);
        savePricesToCache(ticker, "full", prices, interval).catch(() => {});
      } catch (e) {
        console.warn(`    ! price fetch failed for ${ticker}: ${e instanceof Error ? e.message : e}`);
        continue;
      }
    }
    if (prices && prices.length >= 30) out.set(ticker, prices);
  }
  return out;
}

async function fetchEventsForRange(
  pricesByTicker: Map<string, PriceBar[]>
): Promise<Awaited<ReturnType<typeof fetchEconomicCalendar>>> {
  let earliest = new Date();
  let latest = new Date(0);
  for (const prices of pricesByTicker.values()) {
    if (prices.length === 0) continue;
    const a = new Date(prices[0].date);
    const b = new Date(prices[prices.length - 1].date);
    if (a < earliest) earliest = a;
    if (b > latest) latest = b;
  }
  return fetchEconomicCalendar(earliest, latest);
}

function toInsertRow(
  t: BacktestTrade,
  algorithmId: string,
  userId: string,
  runAt: string,
  fallbackTicker: string
) {
  return {
    user_id: userId,
    algorithm_id: algorithmId,
    run_at: runAt,
    ticker: t.ticker ?? fallbackTicker,
    side: t.side,
    entry_date: t.entry_date,
    exit_date: t.exit_date,
    entry_price: t.entry_price,
    exit_price: t.exit_price,
    pnl: t.pnl,
    r_multiple: null,
    exit_reason: t.exit_reason ?? null,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function processAlgo(supabase: any, algo: AlgoRow): Promise<{ ok: boolean; trades: number; note: string }> {
  if (algo.rules.llm_trader?.enabled) {
    return { ok: false, trades: 0, note: "skip — LLM-trader" };
  }
  const wlRes = await supabase
    .from("algorithm_watchlist")
    .select("ticker")
    .eq("algorithm_id", algo.id);
  const tickers = ((wlRes.data ?? []) as { ticker: string }[]).map((w) => w.ticker.toUpperCase());
  if (tickers.length === 0) return { ok: false, trades: 0, note: "skip — empty watchlist" };

  if (!FORCE) {
    const existRes = await supabase
      .from("backtest_trades")
      .select("id")
      .eq("algorithm_id", algo.id)
      .limit(1);
    if ((existRes.data ?? []).length > 0) {
      return { ok: false, trades: 0, note: "skip — already populated (FORCE=1 to overwrite)" };
    }
  }

  const interval = timeframeToInterval(algo.rules.timeframe);
  const pricesByTicker = await loadPricesForTickers(tickers, interval);
  if (pricesByTicker.size === 0) return { ok: false, trades: 0, note: "skip — no price history" };

  const events = algo.rules.news_veto?.enabled ? await fetchEventsForRange(pricesByTicker) : [];
  // Strip prop_firm so the engine emits the FULL trade history — same
  // reason as the server action: with prop_firm enabled, a 2021
  // drawdown trips drawdownBreached permanently and kills every trade
  // for the rest of the 6-year history. FTMO survival simulation is
  // the harness scripts' job, not /backtest replay.
  const replayRules: AlgorithmRules = { ...algo.rules, prop_firm: undefined };
  const result = runPortfolioBacktest(replayRules, pricesByTicker, algo.capital, events);

  if (!APPLY) {
    return { ok: true, trades: result.trades.length, note: "dry-run" };
  }

  const runAt = new Date().toISOString();
  await supabase.from("backtest_trades").delete().eq("algorithm_id", algo.id);
  if (result.trades.length > 0) {
    const rows = result.trades.map((t) => toInsertRow(t, algo.id, algo.user_id, runAt, tickers[0]));
    const ins = await supabase.from("backtest_trades").insert(rows);
    if (ins.error) return { ok: false, trades: 0, note: `write failed: ${ins.error.message}` };
  }
  return { ok: true, trades: result.trades.length, note: "wrote" };
}

async function main(): Promise<void> {
  console.log(`\n===== Backfill backtest_trades @ ${new Date().toISOString().slice(0, 16)} =====`);
  console.log(`Mode: ${APPLY ? "APPLY (writing to Supabase)" : "DRY_RUN (no writes)"}`);
  if (FORCE) console.log(`FORCE=1 — will overwrite existing rows`);
  if (ONLY) console.log(`ONLY=${ONLY}`);
  console.log();

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    process.exit(1);
  }
  const supabase = createClient(url, serviceKey, { auth: { persistSession: false } });

  let query = supabase
    .from("algorithms")
    .select("id, user_id, name, capital, rules")
    .order("name", { ascending: true });
  if (ONLY) query = query.eq("name", ONLY);
  const { data, error } = await query;
  if (error) {
    console.error(`Algo fetch failed: ${error.message}`);
    process.exit(1);
  }
  const algos = (data ?? []) as unknown as AlgoRow[];
  console.log(`Found ${algos.length} algorithm${algos.length === 1 ? "" : "s"} to consider.\n`);

  let wrote = 0;
  let skipped = 0;
  let failed = 0;
  let dryRunOK = 0;

  for (const algo of algos) {
    process.stdout.write(`  ${algo.name} ... `);
    try {
      const res = await processAlgo(supabase, algo);
      if (res.ok && res.note === "wrote") {
        console.log(`✓ wrote ${res.trades} trades`);
        wrote++;
      } else if (res.ok && res.note === "dry-run") {
        console.log(`→ ${res.trades} trades (dry-run, would write)`);
        dryRunOK++;
      } else {
        console.log(`⊝ ${res.note}`);
        skipped++;
      }
    } catch (e) {
      console.log(`✗ ${e instanceof Error ? e.message : "error"}`);
      failed++;
    }
  }

  console.log(`\n----- Summary -----`);
  if (APPLY) {
    console.log(`  Wrote: ${wrote}`);
  } else {
    console.log(`  Would write: ${dryRunOK}`);
  }
  console.log(`  Skipped: ${skipped}`);
  console.log(`  Failed: ${failed}`);
  console.log(`  Mode: ${APPLY ? "APPLY" : "DRY_RUN — re-run with APPLY=1 to write"}\n`);
}

void main();
