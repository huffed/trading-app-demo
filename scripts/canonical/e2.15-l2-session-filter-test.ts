/**
 * E2.15 L2 — Session filter empirical test.
 *
 * Hypothesis: trading only during London open (07:00-10:00 UTC) +
 * NY open (12:00-15:00 UTC) sessions improves Sharpe + reduces DD vs
 * trading all hours, because institutional flow concentrates in these
 * windows.
 *
 * Method: backtest ARB+daily_bias at 0.85% risk on 10.5yr cache;
 * filter the resulting trades by entry_hour ∈ session windows; compute
 * Sharpe + DD on filtered set. Compare to unfiltered baseline.
 *
 * This is a POST-HOC EMPIRICAL TEST — no engine change required.
 * If positive signal, file engine-integration as follow-up (E2.15 L2-impl).
 *
 * Pre-registered windows (LOCKED before run):
 *   London open: 07:00-09:59 UTC (3 hours)
 *   NY open:     12:00-14:59 UTC (3 hours)
 *
 * Pre-registered metrics (LOCKED):
 *   Filtered vs unfiltered: trades, total_return, Sharpe, static DD, daily DD
 *   Gate: filtered Sharpe ≥ baseline Sharpe + 10% AND filtered DD ≤ baseline DD
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { timeframeToInterval } from "../../src/lib/market-data/interval";
import { runPortfolioBacktest } from "../../src/lib/market-data/portfolio-backtest";
import { combinedDailyDrawdownPct, combinedDrawdownPct, perTradePnlDollarsFromTrades } from "../../src/lib/algo-search/portfolio-composer";
import type { Database } from "../../src/lib/supabase/database.types";
import type { BacktestTrade, PriceBar } from "../../src/lib/market-data/types";
import type { AlgorithmRules, EntryCondition } from "../../src/types/algorithm";

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
  } catch {}
}
loadEnvLocal();

const SOURCE_ID = "069813f1-2a80-48e7-a086-5bf22c05e300"; // ARB rr3_lb3_r06_rf1_af0
const POOL_CAPITAL = 10000;
const RISK = 0.85;

const LONDON_OPEN_HOURS = new Set([7, 8, 9]); // 07:00-09:59 UTC
const NY_OPEN_HOURS = new Set([12, 13, 14]); // 12:00-14:59 UTC
const SESSION_HOURS = new Set([...LONDON_OPEN_HOURS, ...NY_OPEN_HOURS]);

function entryHourUtc(t: BacktestTrade): number {
  return new Date(t.entry_date).getUTCHours();
}

function computeSharpe(trades: readonly BacktestTrade[], riskDollars: number): number {
  if (trades.length < 2 || riskDollars <= 0) return 0;
  const r = trades.map((t) => t.pnl / riskDollars);
  const m = r.reduce((a, b) => a + b, 0) / r.length;
  let var_ = 0;
  for (const x of r) var_ += (x - m) ** 2;
  const std = Math.sqrt(var_ / r.length);
  return std === 0 ? 0 : m / std;
}

function stats(label: string, trades: readonly BacktestTrade[], riskDollars: number) {
  if (trades.length === 0) {
    console.log(`${label}: NO TRADES`);
    return;
  }
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const { pnl, exit_dates } = perTradePnlDollarsFromTrades(trades);
  const sdd = combinedDrawdownPct([{ per_trade_pnl_dollars: pnl, exit_dates }], POOL_CAPITAL);
  const ddd = combinedDailyDrawdownPct([{ per_trade_pnl_dollars: pnl, exit_dates }], POOL_CAPITAL);
  const sharpe = computeSharpe(trades, riskDollars);
  const wins = trades.filter((t) => t.pnl > 0).length;
  const wr = (wins / trades.length) * 100;
  const first = trades[0].exit_date.slice(0, 10);
  const last = trades[trades.length - 1].exit_date.slice(0, 10);
  const years = (Date.parse(last) - Date.parse(first)) / (365.25 * 24 * 3600 * 1000);
  const annualPct = years > 0 ? (totalPnl / POOL_CAPITAL) * 100 / years : 0;
  const monthlyPct = annualPct / 12;
  console.log(`${label}:`);
  console.log(`  trades=${trades.length} total_pnl=$${totalPnl.toFixed(0)} sharpe=${sharpe.toFixed(4)}`);
  console.log(`  static_DD=${sdd.toFixed(2)}% daily_DD=${ddd.toFixed(2)}% WR=${wr.toFixed(1)}%`);
  console.log(`  annual=${annualPct.toFixed(2)}% monthly=${monthlyPct.toFixed(3)}%`);
  console.log("");
}

async function main(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const sb = createClient<Database>(url, key);

  const { data: src } = await sb.from("algorithms").select("rules").eq("id", SOURCE_ID).maybeSingle();
  if (!src) throw new Error("source not found");
  const baseRules = src.rules as unknown as AlgorithmRules;
  const augEC: EntryCondition[] = [
    ...baseRules.entry_conditions,
    { type: "pattern", pattern: "daily_bias", direction: "bullish", ma_period: 20, timeframe: "1d" } as EntryCondition,
  ];
  const rules: AlgorithmRules = {
    ...baseRules, entry_conditions: augEC, entry_logic: "all",
    position_sizing: { ...baseRules.position_sizing, type: "risk_per_trade", value: RISK },
  };

  const interval = timeframeToInterval("4h");
  const { data: bd } = await sb.from("price_cache").select("bars")
    .eq("ticker", "XAU/USD").eq("output_size", "full").eq("interval", interval).limit(1).single();
  const bars = bd!.bars as unknown as PriceBar[];

  const result = runPortfolioBacktest(rules, new Map([["XAU/USD", bars]]), POOL_CAPITAL);
  const allTrades = result.trades ?? [];
  const riskDollars = POOL_CAPITAL * (RISK / 100);

  console.log("E2.15 L2 — Session filter empirical test on ARB+daily_bias at 0.85% risk");
  console.log(`Session windows (UTC): London open 07-10, NY open 12-15 (6 hours total)`);
  console.log("");

  // Hour distribution
  const hourBuckets = new Map<number, BacktestTrade[]>();
  for (const t of allTrades) {
    const h = entryHourUtc(t);
    if (!hourBuckets.has(h)) hourBuckets.set(h, []);
    hourBuckets.get(h)!.push(t);
  }
  console.log(`Hour distribution (UTC) of all ${allTrades.length} trades:`);
  for (const h of [...hourBuckets.keys()].sort((a, b) => a - b)) {
    const ts = hourBuckets.get(h)!;
    const wins = ts.filter((t) => t.pnl > 0).length;
    const wr = ((wins / ts.length) * 100).toFixed(1);
    const totalPnl = ts.reduce((s, t) => s + t.pnl, 0).toFixed(0);
    const inSession = SESSION_HOURS.has(h) ? "✓ SESSION" : "";
    console.log(`  ${h.toString().padStart(2)}:00 → ${ts.length.toString().padStart(3)} trades, WR=${wr}%, pnl=$${totalPnl} ${inSession}`);
  }
  console.log("");

  stats("ALL HOURS (baseline)", allTrades, riskDollars);
  const sessionTrades = allTrades.filter((t) => SESSION_HOURS.has(entryHourUtc(t)));
  stats("SESSION ONLY (London 07-10 + NY 12-15)", sessionTrades, riskDollars);
  const londonTrades = allTrades.filter((t) => LONDON_OPEN_HOURS.has(entryHourUtc(t)));
  stats("LONDON ONLY (07-10)", londonTrades, riskDollars);
  const nyTrades = allTrades.filter((t) => NY_OPEN_HOURS.has(entryHourUtc(t)));
  stats("NY ONLY (12-15)", nyTrades, riskDollars);
  const offSessionTrades = allTrades.filter((t) => !SESSION_HOURS.has(entryHourUtc(t)));
  stats("OFF-SESSION (other hours)", offSessionTrades, riskDollars);
}

main().catch((e) => { console.error(e); process.exit(1); });
