/**
 * Verify deployed algo against FTMO's ACTUAL static DD rule:
 *   FTMO Max Loss = 10% of INITIAL balance (FIXED floor at $90K on $100K).
 *   The metric is `min(equity) - initial_balance`, NOT peak-to-trough.
 *
 * Operator clarified 2026-06-29 NIGHT+1: my prior peak-to-trough metric
 * was overly conservative. If equity peaks above starting balance before
 * the drawdown, the FTMO breach metric is LESS than peak-to-trough.
 *
 * Reports BOTH metrics for each risk level to expose the difference +
 * find true FTMO-max risk.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { timeframeToInterval } from "../../src/lib/market-data/interval";
import { runPortfolioBacktest } from "../../src/lib/market-data/portfolio-backtest";
import { combinedDailyDrawdownPct } from "../../src/lib/algo-search/portfolio-composer";
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
  } catch {}
}
loadEnvLocal();

const DEPLOY_ID = "1ebdce3d-4ab9-4e30-b5d3-075942b7cf69";
const POOL_CAPITAL = 10000;
const RISK_LEVELS = [0.85, 1.00, 1.25, 1.50, 1.75, 2.00, 2.25];

/** FTMO Max-Loss metric: max drop from initial balance (NOT peak-to-trough).
 *  Returns 0 if equity never went below initial. */
function ftmoMaxLossPct(trades: readonly BacktestTrade[], initialCapital: number): number {
  if (trades.length === 0 || initialCapital <= 0) return 0;
  const sorted = [...trades].sort((a, b) => a.exit_date.localeCompare(b.exit_date));
  let equity = initialCapital, minEquity = initialCapital;
  for (const t of sorted) {
    equity += t.pnl;
    if (equity < minEquity) minEquity = equity;
  }
  const lossDollars = Math.max(0, initialCapital - minEquity);
  return (lossDollars / initialCapital) * 100;
}

/** Peak-to-trough — my prior "static DD" — overly conservative for FTMO. */
function peakToTroughPct(trades: readonly BacktestTrade[], initialCapital: number): number {
  if (trades.length === 0 || initialCapital <= 0) return 0;
  const sorted = [...trades].sort((a, b) => a.exit_date.localeCompare(b.exit_date));
  let equity = initialCapital, peak = initialCapital, maxDd = 0;
  for (const t of sorted) {
    equity += t.pnl;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDd) maxDd = dd;
  }
  return (maxDd / initialCapital) * 100;
}

async function main(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const sb = createClient<Database>(url, key);

  const { data: dep } = await sb.from("algorithms").select("name, rules").eq("id", DEPLOY_ID).maybeSingle();
  if (!dep) throw new Error("deployed algo not found");
  const deployRules = dep.rules as unknown as AlgorithmRules;

  const interval = timeframeToInterval("4h");
  const { data: bd } = await sb.from("price_cache").select("bars")
    .eq("ticker", "XAU/USD").eq("output_size", "full").eq("interval", interval).limit(1).single();
  const bars = bd!.bars as unknown as PriceBar[];

  console.log(`Deployed algo: ${dep.name}`);
  console.log(`Initial balance: $${POOL_CAPITAL.toLocaleString()}`);
  console.log(`FTMO Max Loss: 10% = $${(POOL_CAPITAL * 0.1).toLocaleString()} floor at $${(POOL_CAPITAL * 0.9).toLocaleString()}`);
  console.log(`FTMO Daily Loss: 5% = $${(POOL_CAPITAL * 0.05).toLocaleString()} per day max`);
  console.log("");
  console.log(`risk%   | trades | total_return | peak-to-trough (overstated) | FTMO MAX LOSS (actual) | daily DD | annual%  | monthly% | FTMO`);
  console.log(`-`.repeat(140));

  for (const risk of RISK_LEVELS) {
    const rules: AlgorithmRules = {
      ...deployRules,
      position_sizing: { ...deployRules.position_sizing, type: "risk_per_trade", value: risk },
    };
    const result = runPortfolioBacktest(rules, new Map([["XAU/USD", bars]]), POOL_CAPITAL);
    const trades = result.trades ?? [];
    const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
    const ptt = peakToTroughPct(trades, POOL_CAPITAL);
    const ftmo = ftmoMaxLossPct(trades, POOL_CAPITAL);
    const daily = combinedDailyDrawdownPct([{ per_trade_pnl_dollars: trades.map((t) => t.pnl), exit_dates: trades.map((t) => t.exit_date) }], POOL_CAPITAL);
    const first = trades[0]?.exit_date.slice(0, 10) ?? "";
    const last = trades[trades.length - 1]?.exit_date.slice(0, 10) ?? "";
    const years = first && last ? (Date.parse(last) - Date.parse(first)) / (365.25 * 24 * 3600 * 1000) : 0;
    const annual = years > 0 ? (totalPnl / POOL_CAPITAL) * 100 / years : 0;
    const monthly = annual / 12;
    const ftmoOK = ftmo <= 10 && daily <= 5;
    const gate = ftmoOK ? "✓" : `✗ (ml${ftmo>10?"!":""} dl${daily>5?"!":""})`;
    console.log(`${risk.toFixed(2).padStart(5)}%  | ${trades.length.toString().padStart(6)} | $${totalPnl.toFixed(0).padStart(11)} | ${ptt.toFixed(2).padStart(6)}%                     | ${ftmo.toFixed(2).padStart(6)}%                 | ${daily.toFixed(2).padStart(5)}%   | ${annual.toFixed(2).padStart(6)}%  | ${monthly.toFixed(3).padStart(7)}%  | ${gate}`);
  }

  console.log("");
  console.log("Note: peak-to-trough may be LARGER than FTMO Max Loss when profits");
  console.log("accumulate above initial before the worst drawdown. FTMO measures");
  console.log("equity vs FIXED $9K floor (10% of $10K initial), NOT vs running peak.");
}

main().catch((e) => { console.error(e); process.exit(1); });
