/**
 * Deploy 3-algo gold portfolio (post multi-algo FTMO stress-test 2026-06-29 NIGHT+2).
 *
 * Empirically dominates single-algo deploy:
 *   single @ 1.25%:  13.5% challenge pass, ~1.40%/mo
 *   3-algo @ 0.80%:  22.5% challenge pass, ~1.79%/mo, 0/529 ML breaches
 *
 * Actions:
 *   1. UPDATE existing deployed algo: risk_per_trade 1.25 → 0.80
 *   2. INSERT 2 new algos (Engulfing rr3_lb6_r1_rf0_af1 + daily_bias,
 *      ARB rr25_lb3_r06_rf1_af0 + daily_bias) at 0.80% risk, paper-only,
 *      news_veto + time_filter active
 *   3. All algos: status=active, live_trading_enabled=false
 *
 * Reversible: SET status='archived' or risk back to 1.25% on existing.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
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

const EXISTING_DEPLOY_ID = "1ebdce3d-4ab9-4e30-b5d3-075942b7cf69";
const RISK = 0.80;
const CAPITAL = 10000;

const NEW_DEPLOYS = [
  {
    source_name: "LayerB: XAU/USD Engulfing-Long 4h | rr3_lb6_r1_rf0_af1",
    deploy_name: "Deploy: XAU/USD Engulfing+DailyBias 4h | r080 v1",
  },
  {
    source_name: "LayerB: XAU/USD AsianRangeBreak-Long 4h | rr25_lb3_r06_rf1_af0",
    deploy_name: "Deploy: XAU/USD ARB25+DailyBias 4h | r080 v1",
  },
];

const DAILY_BIAS_EC: EntryCondition = {
  type: "pattern", pattern: "daily_bias", direction: "bullish", ma_period: 20, timeframe: "1d",
} as EntryCondition;

const NEWS_VETO = { enabled: true, block_minutes_before: 15, block_minutes_after: 30, min_impact: "high" as const };
const TIME_FILTER = { enabled: true, min_wr_pct: 45, min_samples: 5 };

async function deployOne(sb: SupabaseClient<Database>, sourceName: string, deployName: string): Promise<string> {
  const { data: src, error: srcErr } = await sb.from("algorithms")
    .select("user_id, rules, strategy_id, asset_class, leverage")
    .eq("name", sourceName).maybeSingle();
  if (srcErr || !src) throw new Error(`Source not found: ${sourceName}`);
  const { data: existing } = await sb.from("algorithms").select("id").eq("name", deployName).maybeSingle();
  if (existing) {
    console.log(`  Skip ${deployName} — already exists (id ${existing.id})`);
    return existing.id;
  }
  const baseRules = src.rules as unknown as AlgorithmRules;
  const augmentedEC: EntryCondition[] = [...baseRules.entry_conditions, DAILY_BIAS_EC];
  const deployRules: AlgorithmRules = {
    ...baseRules,
    entry_conditions: augmentedEC,
    entry_logic: "all",
    position_sizing: { ...baseRules.position_sizing, type: "risk_per_trade", value: RISK },
    news_veto: NEWS_VETO,
    time_filter: TIME_FILTER,
  };
  const { data: ins, error: insErr } = await sb.from("algorithms").insert({
    user_id: src.user_id,
    name: deployName,
    asset_class: src.asset_class,
    strategy_id: src.strategy_id,
    capital: CAPITAL,
    leverage: src.leverage,
    status: "active",
    live_trading_enabled: false,
    rules: deployRules as unknown as Database["public"]["Tables"]["algorithms"]["Insert"]["rules"],
    backtest_results: {
      computed_at: new Date().toISOString(),
      source: "deploy-multi-algo-portfolio.ts",
      deploy_doc: "g6-portfolio-2026-06-29-night-plus-2",
      base_source_algo: sourceName,
      augmentation: "daily_bias_bullish (logic=all)",
      risk_per_trade: RISK,
      portfolio_role: "co-algo in 3-algo gold portfolio @ 0.80% each",
      expected_combined_monthly_return_pct: 1.79,
      expected_combined_worst_max_loss_pct: 9.11,
      expected_combined_worst_daily_pct: 3.46,
      expected_combined_pass_rate_pct: 22.5,
    } as Database["public"]["Tables"]["algorithms"]["Insert"]["backtest_results"],
  }).select("id").single();
  if (insErr || !ins) throw new Error(`Insert failed for ${deployName}: ${insErr?.message}`);
  const { error: wlErr } = await sb.from("algorithm_watchlist").insert({
    algorithm_id: ins.id, user_id: src.user_id, ticker: "XAU/USD", added_by: "ai",
  });
  if (wlErr) {
    await sb.from("algorithms").delete().eq("id", ins.id);
    throw new Error(`Watchlist insert failed for ${deployName}: ${wlErr.message}`);
  }
  console.log(`  ✓ Deployed ${deployName} (id ${ins.id})`);
  return ins.id;
}

async function main(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const sb = createClient<Database>(url, key);

  console.log("Deploy 3-algo gold portfolio @ 0.80% risk each");
  console.log("");
  console.log("Step 1: Reduce existing deployed algo risk 1.25 → 0.80");
  const { data: updated, error: updErr } = await sb.from("algorithms")
    .update({ rules: undefined } as never)  // placeholder; use raw SQL for JSONB path
    .eq("id", EXISTING_DEPLOY_ID).select("id");
  if (updErr) console.log(`  WARN update (will retry via RPC if needed): ${updErr.message}`);
  // The JSONB path update is easier via SQL — do via .rpc or direct UPDATE statement
  const { data: existing } = await sb.from("algorithms").select("rules").eq("id", EXISTING_DEPLOY_ID).maybeSingle();
  if (!existing) throw new Error(`Existing deploy ${EXISTING_DEPLOY_ID} not found`);
  const existingRules = existing.rules as unknown as AlgorithmRules;
  const updatedRules: AlgorithmRules = {
    ...existingRules,
    position_sizing: { ...existingRules.position_sizing, type: "risk_per_trade", value: RISK },
  };
  const { error: putErr } = await sb.from("algorithms")
    .update({ rules: updatedRules as unknown as Database["public"]["Tables"]["algorithms"]["Update"]["rules"] })
    .eq("id", EXISTING_DEPLOY_ID);
  if (putErr) throw new Error(`Failed to update existing algo risk: ${putErr.message}`);
  console.log(`  ✓ Existing deploy ${EXISTING_DEPLOY_ID} risk_per_trade 1.25 → ${RISK}`);
  console.log("");

  console.log(`Step 2: Insert ${NEW_DEPLOYS.length} new algos at ${RISK}% risk, paper-only`);
  const ids: string[] = [];
  for (const d of NEW_DEPLOYS) {
    ids.push(await deployOne(sb, d.source_name, d.deploy_name));
  }
  console.log("");
  console.log("Done. Portfolio state:");
  const { data: all } = await sb.from("algorithms")
    .select("id, name, status, live_trading_enabled, rules")
    .in("id", [EXISTING_DEPLOY_ID, ...ids]);
  for (const a of all ?? []) {
    const rules = a.rules as unknown as AlgorithmRules;
    console.log(`  [${a.status}|live=${a.live_trading_enabled}] ${a.name} | risk=${rules.position_sizing.value}%`);
  }
  console.log("");
  console.log(`Expected portfolio behavior (per multi-algo-ftmo-stress.ts):`);
  console.log(`  ~1.79%/mo combined return at FTMO 10% Max Loss compliance`);
  console.log(`  22.5% challenge pass rate (vs single algo's 13.5%)`);
  console.log(`  Worst Max Loss across 529 challenge windows: 9.11% (1% FTMO buffer)`);
  console.log(`  Worst Daily Loss: 3.46% (1.5% FTMO buffer)`);
  console.log(`  Zero Max Loss breaches across 529 challenge windows`);
  console.log("");
  console.log(`Reverse if needed:`);
  console.log(`  UPDATE algorithms SET status='archived' WHERE name LIKE 'Deploy: XAU/USD %';`);
  console.log(`  OR set existing algo risk back to 1.25 + archive new ones to revert to single-algo deploy`);
}

main().catch((e) => { console.error(e); process.exit(1); });
