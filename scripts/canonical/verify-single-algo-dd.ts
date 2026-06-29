/**
 * Verify single-algo realistic DD at POOL_CAPITAL=$10K for the top FTMO-passers.
 * E2.11 audit follow-up — explain why composer's 5% fallback selected 0.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { timeframeToInterval } from "../../src/lib/market-data/interval";
import { runPortfolioBacktest } from "../../src/lib/market-data/portfolio-backtest";
import { combinedDrawdownPct, perTradePnlDollarsFromTrades } from "../../src/lib/algo-search/portfolio-composer";
import type { Database } from "../../src/lib/supabase/database.types";
import type { PriceBar } from "../../src/lib/market-data/types";
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

const TARGETS = [
  "LayerB: XAU/USD Engulfing-Long 4h | rr3_lb6_r06_rf1_af1",  // DD 3.50 step2
  "LayerB: XAU/USD Engulfing-Long 4h | rr2_lb6_r06_rf1_af1",  // DD 3.86 step2
  "LayerB: XAU/USD BOS-Long 4h | rr3_lb6_r06_rf0_af1",        // DD 4.15 step2
  "LayerB: XAU/USD Engulfing-Long 4h | rr3_lb6_r06_rf0_af1",  // DD 4.38 step2
  "LayerB: XAU/USD BOS-Long 4h | rr25_lb6_r06_rf1_af1",       // DD 4.77 step2
  "LayerB: XAU/USD Engulfing-Long 4h | rr25_lb6_r06_rf1_af1", // DD 4.59 step2
];
const POOL_CAPITAL = 10000;

async function main(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const sb = createClient<Database>(url, key);

  // Load bars
  const interval = timeframeToInterval("4h");
  const { data: bd } = await sb.from("price_cache").select("bars").eq("ticker", "XAU/USD").eq("output_size", "full").eq("interval", interval).limit(1).single();
  const bars = bd!.bars as unknown as PriceBar[];
  const pricesByTicker = new Map<string, PriceBar[]>([["XAU/USD", bars]]);

  console.log(`Pool capital: $${POOL_CAPITAL}`);
  console.log("");
  console.log(`Variant                                                            | step2 DD | dollar-pool DD | ratio`);
  console.log(`-`.repeat(110));

  for (const name of TARGETS) {
    const { data: row } = await sb.from("algorithms").select("name, rules, capital, backtest_results").eq("name", name).maybeSingle();
    if (!row) { console.log(`${name.slice(0, 65).padEnd(65)} | NOT FOUND`); continue; }
    const rules = row.rules as unknown as AlgorithmRules;
    const step2 = (row.backtest_results as Record<string, unknown> | null)?.step2 as Record<string, unknown> | undefined;
    const step2Dd = Number(step2?.max_drawdown ?? 0);
    const result = runPortfolioBacktest(rules, pricesByTicker, POOL_CAPITAL);
    const { pnl, exit_dates } = perTradePnlDollarsFromTrades(result.trades ?? []);
    const realisticDd = combinedDrawdownPct([{ per_trade_pnl_dollars: pnl, exit_dates }], POOL_CAPITAL);
    const ratio = step2Dd > 0 ? (realisticDd / step2Dd).toFixed(2) : "n/a";
    console.log(`${name.slice(0, 65).padEnd(65)} | ${step2Dd.toFixed(2).padStart(6)}% | ${realisticDd.toFixed(2).padStart(8)}%      | ${ratio}x`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
