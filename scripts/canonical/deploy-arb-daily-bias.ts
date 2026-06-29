/**
 * G.6 FINAL ship: clone ARB rr3_lb3_r06_rf1_af0 + daily_bias_bullish
 * (logic="all") at risk_per_trade=0.85 as the first stable gold demo
 * player (per 2026-06-29 EVENING-FINAL+1 verdict).
 *
 * Pre-registered config (LOCKED):
 *   Base candidate: LayerB: XAU/USD AsianRangeBreak-Long 4h | rr3_lb3_r06_rf1_af0
 *   Augmentation:   daily_bias_bullish (D1 20-EMA filter, logic=all)
 *   Risk:           0.85% per trade (fits FTMO 10% static + 5% daily gates)
 *   Status:         active (so scan engine evaluates it)
 *   Live trading:   FALSE (paper-only first per [[feedback_live_mirror_milestone]])
 *   Capital:        $10,000 (matches backtest pool)
 *   Name:           Deploy: XAU/USD ARB+DailyBias 4h | r085 v1
 *
 * Reversible: SET status='archived' to fully stop; SET live_trading_enabled=false
 * to keep paper-only.
 *
 * Backtest expectations (per realistic dollar-pool sim):
 *   Monthly return: ~0.77% (157 trades / 10.5yr backtest scaled)
 *   Static DD:      ~9% (FTMO 10% buffer 1%)
 *   Daily DD:       ~3% (FTMO 5% buffer 2%)
 *   WR:             39.5%
 *
 * Idempotent: if a row with same name exists, ABORT unless OVERWRITE=1.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "../../src/lib/supabase/database.types";
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

const SOURCE_NAME = "LayerB: XAU/USD AsianRangeBreak-Long 4h | rr3_lb3_r06_rf1_af0";
const DEPLOY_NAME = "Deploy: XAU/USD ARB+DailyBias 4h | r085 v1";
const RISK_PER_TRADE = 0.85;
const CAPITAL = 10000;
const TICKER = "XAU/USD";

async function main(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY required");
  const sb = createClient<Database>(url, key);
  const overwrite = process.env.OVERWRITE === "1";

  // Fetch source (algorithms table has no prop_firm_preset col — friction lives in rules.prop_firm)
  const { data: src, error: srcErr } = await sb.from("algorithms")
    .select("user_id, name, rules, strategy_id, asset_class, leverage")
    .eq("name", SOURCE_NAME).maybeSingle();
  if (srcErr || !src) throw new Error(`Source not found: ${SOURCE_NAME} — ${srcErr?.message ?? "row missing"}`);

  // Check existing deploy row
  const { data: existing } = await sb.from("algorithms").select("id").eq("name", DEPLOY_NAME).maybeSingle();
  if (existing) {
    if (!overwrite) {
      console.error(`Deploy row already exists: ${DEPLOY_NAME}. Set OVERWRITE=1 to replace.`);
      process.exit(1);
    }
    await sb.from("algorithms").delete().eq("id", existing.id);
    console.log(`Deleted existing deploy row (OVERWRITE=1)`);
  }

  // Build deploy rules: source + daily_bias + risk_per_trade=0.85
  const baseRules = src.rules as unknown as AlgorithmRules;
  const augmentedEntryConditions: EntryCondition[] = [
    ...baseRules.entry_conditions,
    { type: "pattern", pattern: "daily_bias", direction: "bullish", ma_period: 20, timeframe: "1d" } as EntryCondition,
  ];
  const deployRules: AlgorithmRules = {
    ...baseRules,
    entry_conditions: augmentedEntryConditions,
    entry_logic: "all",
    position_sizing: { ...baseRules.position_sizing, type: "risk_per_trade", value: RISK_PER_TRADE },
  };

  // Persist deploy row + watchlist
  const { data: ins, error: insErr } = await sb.from("algorithms").insert({
    user_id: src.user_id,
    name: DEPLOY_NAME,
    asset_class: src.asset_class,
    strategy_id: src.strategy_id,
    capital: CAPITAL,
    leverage: src.leverage,
    status: "active",
    live_trading_enabled: false, // paper-only first
    rules: deployRules as unknown as Database["public"]["Tables"]["algorithms"]["Insert"]["rules"],
    backtest_results: {
      computed_at: new Date().toISOString(),
      source: "deploy-arb-daily-bias.ts",
      deploy_doc: "g6-final-2026-06-29-evening-final-plus-1",
      base_source_algo: SOURCE_NAME,
      augmentation: "daily_bias_bullish (logic=all)",
      risk_per_trade: RISK_PER_TRADE,
      expected_monthly_return_pct: 0.77,
      expected_static_dd_pct: 9.0,
      expected_daily_dd_pct: 3.0,
      expected_win_rate_pct: 39.5,
      ftmo_compliance_buffer_static_pct: 1.0,
      ftmo_compliance_buffer_daily_pct: 2.0,
    } as Database["public"]["Tables"]["algorithms"]["Insert"]["backtest_results"],
  }).select("id").single();
  if (insErr || !ins) throw new Error(`Insert failed: ${insErr?.message}`);

  const { error: wlErr } = await sb.from("algorithm_watchlist").insert({
    algorithm_id: ins.id,
    user_id: src.user_id,
    ticker: TICKER,
    added_by: "ai",
  });
  if (wlErr) {
    await sb.from("algorithms").delete().eq("id", ins.id);
    throw new Error(`Watchlist insert failed (algo rolled back): ${wlErr.message}`);
  }

  console.log("");
  console.log("=".repeat(72));
  console.log("G.6 SHIP — DEPLOY SUCCESSFUL");
  console.log("=".repeat(72));
  console.log(`Algo name           : ${DEPLOY_NAME}`);
  console.log(`Algo ID             : ${ins.id}`);
  console.log(`Status              : active`);
  console.log(`Live trading        : FALSE (paper-only first per live-mirror-milestone rule)`);
  console.log(`Capital             : $${CAPITAL.toLocaleString()}`);
  console.log(`Risk per trade      : ${RISK_PER_TRADE}% (FTMO-fit)`);
  console.log(`Entry conditions    : [asian_range_break + daily_bias_bullish] logic=all`);
  console.log(`Ticker watchlist    : ${TICKER}`);
  console.log("");
  console.log(`Expected backtest behaviour:`);
  console.log(`  monthly return    : ~0.77% on $${CAPITAL}`);
  console.log(`  static DD         : ~9% (FTMO 10% buffer ~1%)`);
  console.log(`  daily DD          : ~3% (FTMO 5% buffer ~2%)`);
  console.log(`  WR                : ~39.5%`);
  console.log(`  trade rate        : ~15 trades/yr (~1.25/mo)`);
  console.log("");
  console.log(`Reverse if needed   : UPDATE algorithms SET status='archived' WHERE id='${ins.id}';`);
  console.log(`Enable live trading : UPDATE algorithms SET live_trading_enabled=true WHERE id='${ins.id}';`);
  console.log("");
  console.log(`Next milestones (per [[feedback_live_mirror_milestone]] + G.7 demo period):`);
  console.log(`  1. Paper demo ≥10 trades → verify mean-R within ±30% of in-sample 0.44R`);
  console.log(`  2. Paper demo ≥30 trades → enable live trading if aligned`);
  console.log(`  3. Live ≥30 trades → consider real $10K FTMO challenge`);
  console.log(`  4. While live: E2.15 L2-L5 stacking in parallel to push toward 1%/mo gold target`);
}

main().catch((e) => { console.error(e); process.exit(1); });
