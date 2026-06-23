/**
 * G.3 validation script — A/B compare risk_per_trade vs vol_target sizing
 * on the same algo / same bars / same data window.
 *
 * Usage:
 *   ALGO_ID=<uuid> [TARGET_VOL_PCT=5] [MIN_VOL_FLOOR=0.002] [ROLLING_WINDOW=20] \
 *     pnpm dlx tsx scripts/canonical/vol-target-ab-validate.ts
 *
 * Defaults run against the Engulfing rr3_lb6_r06 v3 survivor with
 * target_vol_pct=5% (operator-recommended FTMO-safe target).
 *
 * What it does:
 *   1. Load algo row + watchlist from Supabase (no rule mutation)
 *   2. Load bars from price_cache (same path validate-algo uses)
 *   3. Run runPortfolioBacktest with the existing risk_per_trade sizing → BASELINE
 *   4. Run runPortfolioBacktest with a vol_target clone of the same rules → CHALLENGER
 *   5. Print A/B comparison + G.3 gate verdict
 *
 * Pure-read; the vol_target swap is in-memory only.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { runPortfolioBacktest } from "../../src/lib/market-data/portfolio-backtest";
import { rulesFromRow } from "../../src/lib/supabase/row-mappers";
import type { Database } from "../../src/lib/supabase/database.types";
import type { BacktestMetrics, PriceBar } from "../../src/lib/market-data/types";
import type { AlgorithmRules } from "../../src/types/algorithm";

function loadEnvLocal(): void {
  try {
    const envText = readFileSync(resolve(process.cwd(), ".env.local"), "utf-8");
    for (const line of envText.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      if (!(key in process.env)) process.env[key] = val;
    }
  } catch {
    // .env.local missing → operator must export envs themselves
  }
}
loadEnvLocal();

const ALGO_ID = process.env.ALGO_ID ?? "33b705b9-7442-4c73-8d97-4a88ecacb9a1"; // Engulfing rr3_lb6_r06 v3 survivor
const TARGET_VOL_PCT = Number(process.env.TARGET_VOL_PCT ?? "5");
const MIN_VOL_FLOOR = process.env.MIN_VOL_FLOOR ? Number(process.env.MIN_VOL_FLOOR) : undefined;
const ROLLING_WINDOW = process.env.ROLLING_WINDOW ? Number(process.env.ROLLING_WINDOW) : undefined;

function fail(msg: string): never {
  console.error(`[vol-target-ab-validate] ${msg}`);
  process.exit(1);
}

async function getBarsNoTtl(
  supabase: SupabaseClient<Database>,
  ticker: string,
  interval: string,
): Promise<PriceBar[] | null> {
  const { data, error } = await supabase
    .from("price_cache")
    .select("bars")
    .eq("ticker", ticker.toUpperCase())
    .eq("output_size", "full")
    .eq("interval", interval)
    .limit(1)
    .single();
  if (error && error.code !== "PGRST116") {
    throw new Error(`getBarsNoTtl ${ticker} ${interval}: ${error.message}`);
  }
  return (data?.bars as PriceBar[] | null) ?? null;
}

interface RunSummary {
  label: string;
  total_return: number;
  total_trades: number;
  win_rate_pct: number;
  max_drawdown_pct: number;
  sharpe: number;
  static_dd_pct: number;
  daily_dd_pct: number;
}

function summarise(label: string, m: BacktestMetrics): RunSummary {
  return {
    label,
    total_return: m.total_return,
    total_trades: m.total_trades,
    win_rate_pct: m.win_rate,
    max_drawdown_pct: m.max_drawdown,
    sharpe: m.sharpe_ratio,
    static_dd_pct: m.prop_firm_report?.peak_drawdown ?? m.max_drawdown,
    daily_dd_pct: m.prop_firm_report?.max_daily_loss ?? 0,
  };
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

async function main(): Promise<void> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? fail("NEXT_PUBLIC_SUPABASE_URL not set");
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? fail("SUPABASE_SERVICE_ROLE_KEY not set");
  const supabase: SupabaseClient<Database> = createClient(supabaseUrl, serviceKey);

  console.log(`[vol-target-ab-validate] Loading algo ${ALGO_ID} ...`);
  const { data: algoRow, error: algoErr } = await supabase
    .from("algorithms")
    .select("id, name, capital, rules, algorithm_watchlist(ticker)")
    .eq("id", ALGO_ID)
    .single();
  if (algoErr || !algoRow) fail(`algo fetch failed: ${algoErr?.message ?? "no row"}`);

  const rulesBaseline = rulesFromRow(algoRow.rules);
  const capital = Number(algoRow.capital);
  const watchlist = (algoRow.algorithm_watchlist ?? []) as { ticker: string }[];
  const tickers = watchlist.map((w) => w.ticker);
  if (tickers.length === 0) fail(`algo ${ALGO_ID} has no watchlist tickers`);
  if (rulesBaseline.position_sizing.type !== "risk_per_trade") {
    fail(`baseline algo expected risk_per_trade sizing; got ${rulesBaseline.position_sizing.type}`);
  }
  const baselineRiskPct = rulesBaseline.position_sizing.value;

  console.log(`  algo: ${algoRow.name}`);
  console.log(`  capital: $${capital}, tickers: ${tickers.join(", ")}, baseline risk_per_trade: ${baselineRiskPct}%`);

  console.log(`[vol-target-ab-validate] Loading bars from price_cache (${rulesBaseline.timeframe}) ...`);
  const pricesByTicker = new Map<string, PriceBar[]>();
  for (const ticker of tickers) {
    const bars = await getBarsNoTtl(supabase, ticker, rulesBaseline.timeframe);
    if (!bars || bars.length === 0) fail(`no bars cached for ${ticker} (${rulesBaseline.timeframe}) — run validate-algo on this algo first to seed the cache`);
    pricesByTicker.set(ticker, bars);
    console.log(`  ${ticker}: ${bars.length} bars (${bars[0]?.date} → ${bars[bars.length - 1]?.date})`);
  }

  const rulesChallenger: AlgorithmRules = {
    ...rulesBaseline,
    position_sizing: {
      type: "vol_target",
      value: TARGET_VOL_PCT,
      ...(MIN_VOL_FLOOR !== undefined ? { min_vol_floor: MIN_VOL_FLOOR } : {}),
      ...(ROLLING_WINDOW !== undefined ? { rolling_window: ROLLING_WINDOW } : {}),
    },
  };

  console.log(`[vol-target-ab-validate] Running BASELINE (risk_per_trade=${baselineRiskPct}%) ...`);
  const baselineMetrics = runPortfolioBacktest(rulesBaseline, pricesByTicker, capital);
  const baseline = summarise(`baseline rpt=${baselineRiskPct}%`, baselineMetrics);

  console.log(`[vol-target-ab-validate] Running CHALLENGER (vol_target target=${TARGET_VOL_PCT}%, min_floor=${MIN_VOL_FLOOR ?? "default"}, window=${ROLLING_WINDOW ?? "default"}) ...`);
  const challengerMetrics = runPortfolioBacktest(rulesChallenger, pricesByTicker, capital);
  const challenger = summarise(`vol_target=${TARGET_VOL_PCT}%`, challengerMetrics);

  // Comparison
  console.log("\n┌──────────────────────────────────────────────────────────────────────┐");
  console.log("│ A/B comparison — vol_target vs risk_per_trade                        │");
  console.log("└──────────────────────────────────────────────────────────────────────┘");
  const col1 = 22, col2 = 22, col3 = 22, col4 = 14;
  const head = pad("stat", col1) + pad(baseline.label, col2) + pad(challenger.label, col3) + pad("delta", col4);
  console.log(head);
  console.log("-".repeat(head.length));
  const rows: [string, number, number][] = [
    ["total_return ($)", baseline.total_return, challenger.total_return],
    ["total_trades", baseline.total_trades, challenger.total_trades],
    ["win_rate (%)", baseline.win_rate_pct, challenger.win_rate_pct],
    ["max_drawdown (%)", baseline.max_drawdown_pct, challenger.max_drawdown_pct],
    ["static_dd_pct", baseline.static_dd_pct, challenger.static_dd_pct],
    ["daily_dd_pct", baseline.daily_dd_pct, challenger.daily_dd_pct],
    ["sharpe_ratio", baseline.sharpe, challenger.sharpe],
  ];
  for (const [name, a, b] of rows) {
    const delta = b - a;
    console.log(
      pad(name, col1) +
      pad(a.toFixed(2), col2) +
      pad(b.toFixed(2), col3) +
      pad(`${delta >= 0 ? "+" : ""}${delta.toFixed(2)}`, col4)
    );
  }

  // G.3 gate
  console.log("\n┌────────────────────────────────────────────────────────────────────┐");
  console.log("│ G.3 gate verdict                                                   │");
  console.log("└────────────────────────────────────────────────────────────────────┘");
  if (baseline.sharpe === 0) {
    console.log("UNDEFINED — baseline Sharpe is 0; cannot compute % improvement");
  } else {
    const pctImprovement = ((challenger.sharpe - baseline.sharpe) / Math.abs(baseline.sharpe)) * 100;
    const passed = pctImprovement >= 10;
    console.log(`Sharpe improvement: ${pctImprovement.toFixed(1)}%   gate: ≥ 10%   →   ${passed ? "PASS" : "FAIL"}`);
    if (!passed) {
      console.log("");
      console.log("Per ROADMAP G.3 gate clause ('OR documented why not'), FAIL is acceptable if the");
      console.log("operator-facing writeup explains WHY vol_target didn't help. Typical reason for");
      console.log("single-instrument single-TF algos: risk_per_trade already adapts to per-trade vol");
      console.log("via SL distance (wider SL → smaller position), so the marginal benefit of");
      console.log("inverse-vol scaling is small. The bigger wins come in MULTI-instrument portfolios");
      console.log("where vol_target equalises risk contribution across uncorrelated instruments.");
    }
  }
}

main().catch((err) => {
  console.error("[vol-target-ab-validate] unhandled error:", err);
  process.exit(1);
});
