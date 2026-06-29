/**
 * Stress-test deployed algo across ALL possible 60-day FTMO challenge windows.
 *
 * A fresh FTMO challenge starts at $100K with NO profit cushion. If the
 * first 60 days happen to land in a bear regime, the algo could breach
 * Max Loss in the challenge period even though the full-backtest Max
 * Loss is 0%.
 *
 * Method: for each possible start day in the 10.5yr backtest, simulate
 * a 60-day FTMO challenge starting from $100K:
 *   - Walk equity through trades that close within the window
 *   - Track min equity + max daily DD within window
 *   - Window FAILS if min equity ≤ $90K (Max Loss) OR daily DD > 5%
 *
 * Reports: pass-rate across all windows + WORST window scenarios.
 * The MAX FTMO Max Loss across all windows = realistic challenge risk.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
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
  } catch {}
}
loadEnvLocal();

const DEPLOY_ID = "1ebdce3d-4ab9-4e30-b5d3-075942b7cf69";
const INITIAL_CAPITAL = 10000;
const RISK_LEVELS = [0.85, 1.00, 1.25, 1.50];
const CHALLENGE_DAYS = 60;
const FTMO_MAX_LOSS_PCT = 10.0;
const FTMO_DAILY_LOSS_PCT = 5.0;
const FTMO_PROFIT_TARGET_PCT = 10.0;

interface WindowResult {
  start_date: string;
  end_date: string;
  trades_in_window: number;
  min_equity: number;
  max_loss_pct: number;
  worst_daily_loss_pct: number;
  final_equity: number;
  total_return_pct: number;
  ftmo_max_loss_breached: boolean;
  ftmo_daily_loss_breached: boolean;
  ftmo_profit_target_hit: boolean;
  outcome: "PASSED" | "FAILED_MAX_LOSS" | "FAILED_DAILY_LOSS" | "INCOMPLETE";
}

function simulateChallengeWindow(
  trades: readonly BacktestTrade[],
  startDateMs: number,
  endDateMs: number,
  initialCapital: number,
): WindowResult {
  const windowTrades = trades
    .filter((t) => {
      const exit = Date.parse(t.exit_date);
      return exit >= startDateMs && exit <= endDateMs;
    })
    .sort((a, b) => a.exit_date.localeCompare(b.exit_date));
  let equity = initialCapital;
  let minEquity = initialCapital;
  let worstDailyLoss = 0;
  const dailyPnl = new Map<string, number>();
  let profitTargetHit = false;
  let maxLossBreached = false;
  for (const t of windowTrades) {
    const day = t.exit_date.slice(0, 10);
    dailyPnl.set(day, (dailyPnl.get(day) ?? 0) + t.pnl);
    equity += t.pnl;
    if (equity < minEquity) minEquity = equity;
    if (equity <= initialCapital * (1 - FTMO_MAX_LOSS_PCT / 100)) maxLossBreached = true;
    if (equity >= initialCapital * (1 + FTMO_PROFIT_TARGET_PCT / 100)) profitTargetHit = true;
  }
  for (const pnl of dailyPnl.values()) {
    if (pnl < 0) {
      const lossPct = (Math.abs(pnl) / initialCapital) * 100;
      if (lossPct > worstDailyLoss) worstDailyLoss = lossPct;
    }
  }
  const dailyBreached = worstDailyLoss > FTMO_DAILY_LOSS_PCT;
  let outcome: WindowResult["outcome"] = "INCOMPLETE";
  if (maxLossBreached) outcome = "FAILED_MAX_LOSS";
  else if (dailyBreached) outcome = "FAILED_DAILY_LOSS";
  else if (profitTargetHit) outcome = "PASSED";
  return {
    start_date: new Date(startDateMs).toISOString().slice(0, 10),
    end_date: new Date(endDateMs).toISOString().slice(0, 10),
    trades_in_window: windowTrades.length,
    min_equity: minEquity,
    max_loss_pct: Math.max(0, ((initialCapital - minEquity) / initialCapital) * 100),
    worst_daily_loss_pct: worstDailyLoss,
    final_equity: equity,
    total_return_pct: ((equity - initialCapital) / initialCapital) * 100,
    ftmo_max_loss_breached: maxLossBreached,
    ftmo_daily_loss_breached: dailyBreached,
    ftmo_profit_target_hit: profitTargetHit,
    outcome,
  };
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

  console.log(`FTMO challenge-window stress test (${CHALLENGE_DAYS}-day windows)`);
  console.log(`Deployed algo: ${dep.name}`);
  console.log(`Rules: $${INITIAL_CAPITAL.toLocaleString()} initial; Max Loss ≤${FTMO_MAX_LOSS_PCT}% (floor $${INITIAL_CAPITAL*0.9}); Daily ≤${FTMO_DAILY_LOSS_PCT}%; Profit target +${FTMO_PROFIT_TARGET_PCT}%`);
  console.log("");

  for (const risk of RISK_LEVELS) {
    const rules: AlgorithmRules = {
      ...deployRules,
      position_sizing: { ...deployRules.position_sizing, type: "risk_per_trade", value: risk },
    };
    const result = runPortfolioBacktest(rules, new Map([["XAU/USD", bars]]), INITIAL_CAPITAL);
    const trades = (result.trades ?? []).sort((a, b) => a.exit_date.localeCompare(b.exit_date));
    if (trades.length === 0) {
      console.log(`risk ${risk}%: NO TRADES`);
      continue;
    }
    const firstMs = Date.parse(trades[0].exit_date);
    const lastMs = Date.parse(trades[trades.length - 1].exit_date);
    const stepDays = 7; // step start dates by 1 week for coverage without N² compute
    const dayMs = 24 * 3600 * 1000;
    const windowMs = CHALLENGE_DAYS * dayMs;
    const windows: WindowResult[] = [];
    for (let startMs = firstMs; startMs + windowMs <= lastMs; startMs += stepDays * dayMs) {
      windows.push(simulateChallengeWindow(trades, startMs, startMs + windowMs, INITIAL_CAPITAL));
    }
    const passed = windows.filter((w) => w.outcome === "PASSED").length;
    const failedMaxLoss = windows.filter((w) => w.outcome === "FAILED_MAX_LOSS").length;
    const failedDaily = windows.filter((w) => w.outcome === "FAILED_DAILY_LOSS").length;
    const incomplete = windows.filter((w) => w.outcome === "INCOMPLETE").length;
    const worstMaxLoss = Math.max(...windows.map((w) => w.max_loss_pct), 0);
    const worstDaily = Math.max(...windows.map((w) => w.worst_daily_loss_pct), 0);
    const avgFinalReturn = windows.reduce((s, w) => s + w.total_return_pct, 0) / windows.length;
    console.log(`=== risk ${risk}% (${trades.length} trades over ${((lastMs - firstMs) / (365.25 * dayMs)).toFixed(1)}yr) ===`);
    console.log(`  ${windows.length} simulated ${CHALLENGE_DAYS}-day FTMO challenge windows (start dates stepped by ${stepDays} days):`);
    console.log(`    PASSED (hit +${FTMO_PROFIT_TARGET_PCT}%): ${passed} (${((passed/windows.length)*100).toFixed(1)}%)`);
    console.log(`    FAILED Max Loss (≥${FTMO_MAX_LOSS_PCT}% drop): ${failedMaxLoss} (${((failedMaxLoss/windows.length)*100).toFixed(1)}%)`);
    console.log(`    FAILED Daily Loss (>${FTMO_DAILY_LOSS_PCT}% in one day): ${failedDaily} (${((failedDaily/windows.length)*100).toFixed(1)}%)`);
    console.log(`    INCOMPLETE (no breach + no target by window end): ${incomplete} (${((incomplete/windows.length)*100).toFixed(1)}%)`);
    console.log(`  WORST window Max Loss: ${worstMaxLoss.toFixed(2)}%`);
    console.log(`  WORST window Daily Loss: ${worstDaily.toFixed(2)}%`);
    console.log(`  AVG final return per window: ${avgFinalReturn.toFixed(2)}%`);
    console.log("");
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
