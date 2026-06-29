/**
 * Verify ARB rr3_lb3_r06_rf1_af0 + daily_bias at FTMO-scaled risk (1.76%)
 * gives realistic DD ≤ 10% static + ≤ 5% daily on dollar-pool sim.
 *
 * Operator clarification 2026-06-29 EVENING-FINAL+1: DD gate is FTMO
 * 5% daily / 10% overall, NOT the over-conservative 5% static I'd been
 * using. Re-running at corrected risk-to-fit.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { timeframeToInterval } from "../../src/lib/market-data/interval";
import { runPortfolioBacktest } from "../../src/lib/market-data/portfolio-backtest";
import { combinedDailyDrawdownPct, combinedDrawdownPct, perTradePnlDollarsFromTrades } from "../../src/lib/algo-search/portfolio-composer";
import type { Database } from "../../src/lib/supabase/database.types";
import type { PriceBar } from "../../src/lib/market-data/types";
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

const TARGET_ALGO_ID = "069813f1-2a80-48e7-a086-5bf22c05e300"; // ARB rr3_lb3_r06_rf1_af0
const RISK_LEVELS = [1.0, 1.25, 1.5, 1.76, 2.0]; // sweep across to find max-risk that fits FTMO 10% static
const POOL_CAPITAL = 10000;

async function main(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const sb = createClient<Database>(url, key);

  const { data: row } = await sb.from("algorithms")
    .select("name, rules").eq("id", TARGET_ALGO_ID).maybeSingle();
  if (!row) throw new Error("algo not found");

  const baseRules = row.rules as unknown as AlgorithmRules;
  const augmentedEC: EntryCondition[] = [
    ...baseRules.entry_conditions,
    { type: "pattern", pattern: "daily_bias", direction: "bullish", ma_period: 20, timeframe: "1d" } as EntryCondition,
  ];

  const interval = timeframeToInterval("4h");
  const { data: bd } = await sb.from("price_cache").select("bars")
    .eq("ticker", "XAU/USD").eq("output_size", "full").eq("interval", interval).limit(1).single();
  const bars = bd!.bars as unknown as PriceBar[];
  const pricesByTicker = new Map<string, PriceBar[]>([["XAU/USD", bars]]);

  console.log(`ARB rr3_lb3_r06_rf1_af0 + daily_bias (logic=all) — risk sweep for FTMO gate fit`);
  console.log(`Pool capital: $${POOL_CAPITAL}`);
  console.log("");
  console.log(`risk%   | trades | total_return | static_DD | daily_DD | annual%  | monthly%  | FTMO 10% gate | FTMO 5% daily gate`);
  console.log(`-`.repeat(120));

  for (const riskPct of RISK_LEVELS) {
    const augRules: AlgorithmRules = {
      ...baseRules,
      entry_conditions: augmentedEC,
      entry_logic: "all",
      position_sizing: { ...baseRules.position_sizing, type: "risk_per_trade", value: riskPct },
    };
    const result = runPortfolioBacktest(augRules, pricesByTicker, POOL_CAPITAL);
    const trades = result.trades ?? [];
    const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
    const { pnl, exit_dates } = perTradePnlDollarsFromTrades(trades);
    const staticDd = combinedDrawdownPct([{ per_trade_pnl_dollars: pnl, exit_dates }], POOL_CAPITAL);
    const dailyDd = combinedDailyDrawdownPct([{ per_trade_pnl_dollars: pnl, exit_dates }], POOL_CAPITAL);
    const firstDate = exit_dates[0] ?? "";
    const lastDate = exit_dates[exit_dates.length - 1] ?? "";
    const years = (Date.parse(lastDate) - Date.parse(firstDate)) / (365.25 * 24 * 3600 * 1000);
    const annual = years > 0 ? (totalPnl / POOL_CAPITAL) * 100 / years : 0;
    const monthly = annual / 12;
    const ftmoStaticGate = staticDd <= 10 ? "✓" : "✗";
    const ftmoDailyGate = dailyDd <= 5 ? "✓" : "✗";
    console.log(`${riskPct.toFixed(2).padStart(5)}%  | ${trades.length.toString().padStart(6)} | $${totalPnl.toFixed(0).padStart(11)} | ${staticDd.toFixed(2).padStart(6)}%   | ${dailyDd.toFixed(2).padStart(5)}%   | ${annual.toFixed(2).padStart(6)}%  | ${monthly.toFixed(2).padStart(7)}%   | ${ftmoStaticGate.padStart(8)}      | ${ftmoDailyGate.padStart(11)}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
