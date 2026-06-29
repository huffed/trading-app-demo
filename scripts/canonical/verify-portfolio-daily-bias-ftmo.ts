/**
 * Compare single-algo vs 3-algo portfolio for FTMO 10% static + 5% daily gate.
 * Operator clarified 2026-06-29 EVENING-FINAL+1: gate is FTMO 5%/10%, target
 * is 1%/mo gold-portfolio (not per-algo).
 *
 * Tests:
 *   A) Single best: ARB rr3_lb3_r06_rf1_af0 + daily_bias at risk-to-fit-10%
 *   B) 3-algo daily_bias-augmented portfolio at uniform risk-to-fit-combined-10%
 *
 * Decide which gives more return per FTMO compliance.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
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

const POOL_CAPITAL = 10000;
const ALGOS = [
  { id: "069813f1-2a80-48e7-a086-5bf22c05e300", name: "ARB-rr3_lb3_r06_rf1_af0" },     // augmented Sharpe 0.286
  { id: "daff0052-824a-4cd4-a43c-7fd177fe8513", name: "Engulfing-rr3_lb6_r1_rf0_af1" }, // augmented Sharpe 0.273
  { id: "85d421e6-bcc9-40b5-9ee4-be1e7d6fea03", name: "ARB-rr25_lb3_r06_rf1_af0" },     // augmented Sharpe 0.266
];

async function loadAugmentedTrades(sb: SupabaseClient<Database>, id: string, bars: PriceBar[], riskPct: number) {
  const { data: row } = await sb.from("algorithms").select("rules").eq("id", id).maybeSingle();
  if (!row) throw new Error(`algo ${id} not found`);
  const baseRules = row.rules as unknown as AlgorithmRules;
  const augmentedEC: EntryCondition[] = [
    ...baseRules.entry_conditions,
    { type: "pattern", pattern: "daily_bias", direction: "bullish", ma_period: 20, timeframe: "1d" } as EntryCondition,
  ];
  const augRules: AlgorithmRules = {
    ...baseRules, entry_conditions: augmentedEC, entry_logic: "all",
    position_sizing: { ...baseRules.position_sizing, type: "risk_per_trade", value: riskPct },
  };
  const pricesByTicker = new Map<string, PriceBar[]>([["XAU/USD", bars]]);
  const result = runPortfolioBacktest(augRules, pricesByTicker, POOL_CAPITAL);
  const trades = result.trades ?? [];
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const { pnl, exit_dates } = perTradePnlDollarsFromTrades(trades);
  return { trades_count: trades.length, total_pnl: totalPnl, per_trade_pnl_dollars: pnl, exit_dates };
}

async function main(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const sb = createClient<Database>(url, key);
  const interval = timeframeToInterval("4h");
  const { data: bd } = await sb.from("price_cache").select("bars")
    .eq("ticker", "XAU/USD").eq("output_size", "full").eq("interval", interval).limit(1).single();
  const bars = bd!.bars as unknown as PriceBar[];

  console.log(`FTMO 10% static + 5% daily gate — single vs 3-algo portfolio comparison`);
  console.log(`Pool capital: $${POOL_CAPITAL}, all algos augmented with daily_bias logic=all`);
  console.log("");

  // SINGLE: ARB rr3_lb3_r06_rf1_af0 + daily_bias across risk levels
  console.log("=== A) SINGLE: ARB rr3_lb3_r06_rf1_af0 + daily_bias ===");
  console.log(`risk%   | static_DD | daily_DD | annual%  | monthly%  | FTMO`);
  console.log(`-`.repeat(70));
  for (const r of [0.50, 0.75, 0.93, 1.00]) {
    const t = await loadAugmentedTrades(sb, ALGOS[0].id, bars, r);
    const sdd = combinedDrawdownPct([{ per_trade_pnl_dollars: t.per_trade_pnl_dollars, exit_dates: t.exit_dates }], POOL_CAPITAL);
    const ddd = combinedDailyDrawdownPct([{ per_trade_pnl_dollars: t.per_trade_pnl_dollars, exit_dates: t.exit_dates }], POOL_CAPITAL);
    const first = t.exit_dates[0] ?? "";
    const last = t.exit_dates[t.exit_dates.length - 1] ?? "";
    const years = (Date.parse(last) - Date.parse(first)) / (365.25 * 24 * 3600 * 1000);
    const annual = years > 0 ? (t.total_pnl / POOL_CAPITAL) * 100 / years : 0;
    const monthly = annual / 12;
    const gate = sdd <= 10 && ddd <= 5 ? "✓" : `✗ (sdd${sdd>10?"!":""} ddd${ddd>5?"!":""})`;
    console.log(`${r.toFixed(2).padStart(5)}%  | ${sdd.toFixed(2).padStart(6)}%   | ${ddd.toFixed(2).padStart(5)}%   | ${annual.toFixed(2).padStart(6)}%  | ${monthly.toFixed(2).padStart(7)}%   | ${gate}`);
  }

  // PORTFOLIO: 3 algos at uniform risk
  console.log("");
  console.log("=== B) 3-ALGO PORTFOLIO: top-3 by augmented Sharpe ===");
  console.log(`risk%   | static_DD | daily_DD | annual%  | monthly%  | FTMO`);
  console.log(`-`.repeat(70));
  for (const r of [0.25, 0.35, 0.45, 0.55]) {
    const algoTrades = [];
    for (const a of ALGOS) {
      algoTrades.push(await loadAugmentedTrades(sb, a.id, bars, r));
    }
    const candidatesForDd = algoTrades.map((t) => ({ per_trade_pnl_dollars: t.per_trade_pnl_dollars, exit_dates: t.exit_dates }));
    const sdd = combinedDrawdownPct(candidatesForDd, POOL_CAPITAL);
    const ddd = combinedDailyDrawdownPct(candidatesForDd, POOL_CAPITAL);
    const totalPnl = algoTrades.reduce((s, t) => s + t.total_pnl, 0);
    const allDates = algoTrades.flatMap((t) => t.exit_dates).sort();
    const first = allDates[0] ?? "";
    const last = allDates[allDates.length - 1] ?? "";
    const years = (Date.parse(last) - Date.parse(first)) / (365.25 * 24 * 3600 * 1000);
    const annual = years > 0 ? (totalPnl / POOL_CAPITAL) * 100 / years : 0;
    const monthly = annual / 12;
    const gate = sdd <= 10 && ddd <= 5 ? "✓" : `✗ (sdd${sdd>10?"!":""} ddd${ddd>5?"!":""})`;
    console.log(`${r.toFixed(2).padStart(5)}%  | ${sdd.toFixed(2).padStart(6)}%   | ${ddd.toFixed(2).padStart(5)}%   | ${annual.toFixed(2).padStart(6)}%  | ${monthly.toFixed(2).padStart(7)}%   | ${gate}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
