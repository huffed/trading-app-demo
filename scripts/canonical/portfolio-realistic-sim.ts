/**
 * E2.10 audit (2026-06-29 EVE LATE): realistic combined-DD simulation.
 *
 * The composePortfolio crude proxy used 1/N R-scaling which understates
 * true combined DD. This driver runs each portfolio candidate at its
 * ACTUAL risk_per_trade against a SHARED capital pool, walks the
 * combined equity curve at dollar precision + day granularity, computes
 * realistic max static DD + daily DD.
 *
 * Method:
 *   1. Load each portfolio candidate's rules + capital
 *   2. Run runPortfolioBacktest per candidate → get full BacktestTrade[] with pnl
 *   3. Pool starting capital = max of any single algo's capital (operator runs ONE FTMO account)
 *   4. Aggregate ALL trades sorted by exit_date, apply pnl to single equity curve
 *   5. Day-by-day equity: peak, trough → static DD %
 *   6. Day-by-day daily PnL → daily DD %
 *   7. Compare vs operator 5% rule + FTMO 10% static / 5% daily
 *
 * Honest numbers, not the crude proxy.
 *
 * USAGE:
 *   pnpm dlx tsx scripts/canonical/portfolio-realistic-sim.ts
 *
 * Env (defaults match E2.10 portfolio):
 *   PORTFOLIO_NAMES_CSV  default: 3 algos from portfolio-2026-06-29.json
 *   POOL_CAPITAL         default: 10000 (per-algo capital from algorithms table)
 *   OUTPUT_JSON          default: scripts/canonical/e2-results/portfolio-realistic-2026-06-29.json
 */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { timeframeToInterval } from "../../src/lib/market-data/interval";
import { runPortfolioBacktest } from "../../src/lib/market-data/portfolio-backtest";
import type { Database } from "../../src/lib/supabase/database.types";
import type { BacktestTrade, PriceBar } from "../../src/lib/market-data/types";
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
  } catch { /* operator exports envs themselves */ }
}
loadEnvLocal();

const DEFAULT_PORTFOLIO = [
  "LayerB: XAU/USD AsianRangeBreak-Long 4h | rr3_lb6_r1_rf1_af0",
  "LayerB: XAU/USD Engulfing-Long 4h | rr3_lb6_r1_rf0_af1",
  "LayerB: XAU/USD Engulfing-Long 4h | rr2_lb4_r1_rf1_af0",
];
const PORTFOLIO_NAMES = (process.env.PORTFOLIO_NAMES_CSV ?? DEFAULT_PORTFOLIO.join(",")).split(",");
const POOL_CAPITAL = Number(process.env.POOL_CAPITAL ?? 10000);
const OUTPUT_JSON = process.env.OUTPUT_JSON ?? "scripts/canonical/e2-results/portfolio-realistic-2026-06-29.json";

function requireEnv(): { url: string; key: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY required");
  return { url, key };
}

function extractTicker(name: string): string {
  return name.replace(/^LayerB:\s*/, "").split(" ")[0] ?? "XAU/USD";
}

function extractTimeframe(name: string): string {
  return name.match(/\s(\d+[mh])\s/)?.[1] ?? "4h";
}

async function loadBars(sb: SupabaseClient<Database>, ticker: string, timeframe: string): Promise<PriceBar[]> {
  const interval = timeframeToInterval(timeframe);
  const { data, error } = await sb
    .from("price_cache").select("bars")
    .eq("ticker", ticker.toUpperCase()).eq("output_size", "full").eq("interval", interval)
    .limit(1).single();
  if (error || !data) throw new Error(`No bars for ${ticker} ${interval}: ${error?.message}`);
  return data.bars as unknown as PriceBar[];
}

interface AlgoTrades {
  name: string;
  trades: BacktestTrade[];
  risk_dollars: number;
}

async function main(): Promise<void> {
  const { url, key } = requireEnv();
  const sb = createClient<Database>(url, key);

  console.log("E2.10 audit: realistic combined-DD simulation");
  console.log(`  pool capital     : $${POOL_CAPITAL}`);
  console.log(`  portfolio algos  : ${PORTFOLIO_NAMES.length}`);
  for (const n of PORTFOLIO_NAMES) console.log(`    - ${n}`);
  console.log("");

  // Load each algo's rules + run backtest at its ACTUAL risk_per_trade
  const algoTrades: AlgoTrades[] = [];
  const barsCache = new Map<string, PriceBar[]>();

  for (const name of PORTFOLIO_NAMES) {
    const { data: row, error } = await sb.from("algorithms")
      .select("name, rules, capital").eq("name", name).maybeSingle();
    if (error || !row) throw new Error(`Algo not found: ${name}`);
    const rules = row.rules as unknown as AlgorithmRules;
    const ticker = extractTicker(name);
    const tf = extractTimeframe(name);
    const barsKey = `${ticker}|${tf}`;
    let bars = barsCache.get(barsKey);
    if (!bars) {
      bars = await loadBars(sb, ticker, tf);
      barsCache.set(barsKey, bars);
    }
    const pricesByTicker = new Map<string, PriceBar[]>([[ticker.toUpperCase(), bars]]);
    // Run at POOL_CAPITAL not algo's individual capital — single shared pool
    const result = runPortfolioBacktest(rules, pricesByTicker, POOL_CAPITAL);
    const trades = result.trades ?? [];
    const sizing = rules.position_sizing;
    const riskPct = sizing?.type === "risk_per_trade" ? sizing.value : 1.0;
    const riskDollars = POOL_CAPITAL * (riskPct / 100);
    algoTrades.push({ name, trades, risk_dollars: riskDollars });
    const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
    const maxR = Math.max(...trades.map((t) => Math.abs(t.pnl / riskDollars)), 0);
    console.log(`  ${name.slice(0, 65).padEnd(65)} trades=${trades.length} pnl=$${totalPnl.toFixed(0)} max|R|=${maxR.toFixed(2)} risk_per=$${riskDollars}`);
  }
  console.log("");

  // Aggregate all trades sorted by exit_date with pnl (NOT R, NOT 1/N scaled)
  type Event = { date: string; pnl: number; algo: string };
  const events: Event[] = [];
  for (const a of algoTrades) {
    for (const t of a.trades) {
      events.push({ date: t.exit_date.slice(0, 10), pnl: t.pnl, algo: a.name });
    }
  }
  events.sort((a, b) => a.date.localeCompare(b.date));

  // Group by day for daily-PnL DD
  const dailyPnl = new Map<string, number>();
  for (const e of events) {
    dailyPnl.set(e.date, (dailyPnl.get(e.date) ?? 0) + e.pnl);
  }

  // Walk single equity curve at dollar precision
  let equity = POOL_CAPITAL;
  let peak = POOL_CAPITAL;
  let maxStaticDdDollars = 0;
  let peakDate = "";
  let troughDate = "";
  let currentPeakDate = "";
  for (const e of events) {
    equity += e.pnl;
    if (equity > peak) {
      peak = equity;
      currentPeakDate = e.date;
    }
    const dd = peak - equity;
    if (dd > maxStaticDdDollars) {
      maxStaticDdDollars = dd;
      peakDate = currentPeakDate;
      troughDate = e.date;
    }
  }
  const maxStaticDdPct = (maxStaticDdDollars / POOL_CAPITAL) * 100;
  const totalReturn = equity - POOL_CAPITAL;
  const totalReturnPct = (totalReturn / POOL_CAPITAL) * 100;

  // Daily DD = worst single-day net PnL as % of capital
  let worstDailyPnl = 0;
  let worstDailyDate = "";
  for (const [date, pnl] of dailyPnl.entries()) {
    if (pnl < worstDailyPnl) {
      worstDailyPnl = pnl;
      worstDailyDate = date;
    }
  }
  const worstDailyDdPct = (Math.abs(worstDailyPnl) / POOL_CAPITAL) * 100;

  // Sample period
  const firstDate = events[0]?.date ?? "";
  const lastDate = events[events.length - 1]?.date ?? "";
  const yearsApprox = events.length > 1
    ? (Date.parse(lastDate) - Date.parse(firstDate)) / (365.25 * 24 * 3600 * 1000)
    : 0;
  const annualReturnPct = yearsApprox > 0 ? totalReturnPct / yearsApprox : 0;

  console.log("=".repeat(72));
  console.log(`E2.10 REALISTIC COMBINED-DD VERDICT`);
  console.log("=".repeat(72));
  console.log(`Sample period       : ${firstDate} → ${lastDate} (~${yearsApprox.toFixed(2)}yr)`);
  console.log(`Pool capital        : $${POOL_CAPITAL.toLocaleString()}`);
  console.log(`Total trades        : ${events.length}`);
  console.log(`Total return        : $${totalReturn.toFixed(0)} (${totalReturnPct.toFixed(2)}% cumulative / ${annualReturnPct.toFixed(2)}%/yr / ${(annualReturnPct/12).toFixed(2)}%/mo)`);
  console.log(`Final equity        : $${equity.toFixed(0)}`);
  console.log("");
  console.log(`Max STATIC DD       : $${maxStaticDdDollars.toFixed(0)} = ${maxStaticDdPct.toFixed(2)}% of capital`);
  console.log(`  peak  → trough    : ${peakDate} → ${troughDate}`);
  console.log(`Max DAILY DD        : $${Math.abs(worstDailyPnl).toFixed(0)} = ${worstDailyDdPct.toFixed(2)}% of capital  (on ${worstDailyDate})`);
  console.log("");
  console.log("Gate comparison:");
  console.log(`  FTMO static DD ≤ 10%  : ${maxStaticDdPct <= 10 ? "✓ PASS" : `✗ FAIL (${maxStaticDdPct.toFixed(2)}%)`}`);
  console.log(`  FTMO daily DD ≤ 5%    : ${worstDailyDdPct <= 5 ? "✓ PASS" : `✗ FAIL (${worstDailyDdPct.toFixed(2)}%)`}`);
  console.log(`  Operator DD-gate ≤ 5% : ${maxStaticDdPct <= 5 ? "✓ PASS" : `✗ FAIL (${maxStaticDdPct.toFixed(2)}%) — [[feedback_dd_validation_gate]] VIOLATED`}`);
  console.log(`  Operator 2-3%/mo      : ${annualReturnPct/12 >= 2 ? "✓ PASS" : `✗ FAIL (${(annualReturnPct/12).toFixed(2)}%/mo) — [[feedback_target_recalibrated_2_to_3_pct]] BELOW`}`);

  const output = {
    audit: "E2.10 realistic combined-DD simulation",
    pool_capital: POOL_CAPITAL,
    portfolio_algos: PORTFOLIO_NAMES,
    sample_period: { first: firstDate, last: lastDate, years_approx: yearsApprox },
    total_trades: events.length,
    total_return_dollars: totalReturn,
    total_return_pct_cumulative: totalReturnPct,
    annual_return_pct: annualReturnPct,
    monthly_return_pct: annualReturnPct / 12,
    max_static_dd_dollars: maxStaticDdDollars,
    max_static_dd_pct: maxStaticDdPct,
    max_static_dd_peak_date: peakDate,
    max_static_dd_trough_date: troughDate,
    max_daily_dd_dollars: Math.abs(worstDailyPnl),
    max_daily_dd_pct: worstDailyDdPct,
    max_daily_dd_date: worstDailyDate,
    gate_verdicts: {
      ftmo_static_dd_10pct: maxStaticDdPct <= 10,
      ftmo_daily_dd_5pct: worstDailyDdPct <= 5,
      operator_dd_gate_5pct: maxStaticDdPct <= 5,
      operator_monthly_target_2pct: annualReturnPct / 12 >= 2,
    },
    generated_at: new Date().toISOString(),
  };

  mkdirSync(dirname(OUTPUT_JSON), { recursive: true });
  writeFileSync(OUTPUT_JSON, JSON.stringify(output, null, 2));
  console.log("");
  console.log(`Persisted ${OUTPUT_JSON}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
