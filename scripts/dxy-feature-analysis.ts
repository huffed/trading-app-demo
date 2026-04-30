/**
 * Exploratory analysis: does DXY direction at entry-time predict the
 * outcome of gold trades? Pulls each algo's backtest trade list, joins
 * with EUR/USD price action (proxy for DXY — Twelve Data has no DXY
 * symbol), buckets trades by the DXY-direction proxy at entry, reports
 * mean P&L and win rate per bucket.
 *
 * If the buckets separate cleanly, a DXY directional filter has signal
 * and is worth integrating. If the buckets are statistically similar,
 * the filter is theory-only and should be killed.
 *
 * Usage:
 *   pnpm tsx scripts/dxy-feature-analysis.ts
 *
 * Reads each of the 4 live gold algos by hardcoded ID.
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

const ALGOS = [
  { label: "B (15m short)", id: "65a7fbfe-89a3-435e-806b-8f24a6b4ed68" },
  { label: "C (1h ICT long)", id: "07ca6b2a-ac56-4cfe-86ca-4194c644c52a" },
  { label: "D (1h momentum)", id: "52cc7bc7-2a29-4062-b610-e9c34548f8a2" },
  { label: "E (1h engulf)", id: "f5215d2e-48cb-4204-aba1-7ff8f13c38f8" },
];

/**
 * Find the EUR/USD bar at-or-before a given timestamp. Linear scan is
 * fine — the corpus is 5,000 bars, called once per gold trade (≤66).
 */
function eurUsdAt(eurBars: PriceBar[], tsIso: string): number | null {
  const ts = new Date(tsIso).getTime();
  for (let i = eurBars.length - 1; i >= 0; i--) {
    if (new Date(eurBars[i].date).getTime() <= ts) return eurBars[i].close;
  }
  return null;
}

interface BucketStats {
  count: number;
  pnl: number;
  wins: number;
}

function emptyBucket(): BucketStats {
  return { count: 0, pnl: 0, wins: 0 };
}

function summarise(label: string, b: BucketStats): string {
  if (b.count === 0) return `${label.padEnd(28)} 0 trades`;
  const wr = (b.wins / b.count) * 100;
  const avg = b.pnl / b.count;
  return `${label.padEnd(28)} ${String(b.count).padStart(3)}t · WR ${wr.toFixed(1).padStart(5)}% · avg $${avg.toFixed(0).padStart(6)} · total $${b.pnl.toFixed(0).padStart(7)}`;
}

interface AlgoRow {
  id: string;
  name: string;
  capital: number;
  rules: AlgorithmRules;
}

interface WatchlistRow {
  ticker: string;
}

async function fetchEurUsdBars(): Promise<PriceBar[]> {
  // 1h granularity matches the lookback windows we'll test (4h / 12h
  // direction). Compact span of "full" depth covers the gold-corpus
  // window with margin.
  return fetchDailyPrices("EUR/USD", "full", "1h");
}

async function loadAlgoTrades(
  supabase: SupabaseClient,
  algoId: string
): Promise<{ algoRow: AlgoRow; trades: BacktestTrade[] }> {
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
  const result = runPortfolioBacktest(
    algoRow.rules,
    pricesByTicker,
    Number(algoRow.capital),
    []
  );
  return { algoRow, trades: result.trades };
}

/**
 * For a gold trade with given side and entry timestamp, compute the
 * EUR/USD direction over the preceding N hours and return a bucket
 * label. EUR/USD UP ≈ DXY DOWN ≈ bullish-gold environment; EUR/USD
 * DOWN ≈ DXY UP ≈ bearish-gold environment.
 */
function bucketLabel(
  side: "long" | "short",
  eurEntry: number | null,
  eurNHoursBack: number | null,
  pipThreshold: number
): "aligned" | "against" | "neutral" | "no_data" {
  if (eurEntry == null || eurNHoursBack == null) return "no_data";
  const deltaPips = (eurEntry - eurNHoursBack) * 10000;
  if (Math.abs(deltaPips) < pipThreshold) return "neutral";
  const dxyFalling = deltaPips > 0; // EUR/USD up = DXY down
  // Long gold + DXY falling = aligned (gold-positive backdrop)
  // Short gold + DXY rising = aligned
  if ((side === "long" && dxyFalling) || (side === "short" && !dxyFalling)) {
    return "aligned";
  }
  return "against";
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

  console.log("Fetching EUR/USD 1h corpus (DXY proxy)...");
  const eurBars = await fetchEurUsdBars();
  console.log(
    `  ${eurBars.length} bars  (${eurBars[0]?.date} → ${eurBars[eurBars.length - 1]?.date})`
  );
  console.log("");

  const lookbackHoursOptions = [4, 12];
  const pipThresholds = [3, 8, 15];

  for (const algo of ALGOS) {
    console.log(`=== Algo ${algo.label} ===`);
    const { algoRow, trades } = await loadAlgoTrades(supabase, algo.id);
    console.log(
      `  ${trades.length} backtest trades · side=${algoRow.rules.side ?? "long"} · TF=${algoRow.rules.timeframe}`
    );

    for (const lookbackH of lookbackHoursOptions) {
      for (const pipThresh of pipThresholds) {
        const buckets: Record<string, BucketStats> = {
          aligned: emptyBucket(),
          against: emptyBucket(),
          neutral: emptyBucket(),
          no_data: emptyBucket(),
        };
        for (const t of trades) {
          const eurEntry = eurUsdAt(eurBars, t.entry_date);
          const lookbackTs = new Date(
            new Date(t.entry_date).getTime() - lookbackH * 3600000
          ).toISOString();
          const eurBack = eurUsdAt(eurBars, lookbackTs);
          const label = bucketLabel(
            t.side as "long" | "short",
            eurEntry,
            eurBack,
            pipThresh
          );
          const b = buckets[label];
          b.count++;
          b.pnl += t.pnl;
          if (t.pnl > 0) b.wins++;
        }
        console.log(
          `  lookback=${lookbackH}h · pip_threshold=${pipThresh}:`
        );
        console.log(`    ${summarise("aligned (DXY for us)", buckets.aligned)}`);
        console.log(`    ${summarise("against (DXY against us)", buckets.against)}`);
        console.log(`    ${summarise("neutral", buckets.neutral)}`);
        if (buckets.no_data.count > 0) {
          console.log(`    ${summarise("no_data", buckets.no_data)}`);
        }
      }
    }
    console.log("");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
