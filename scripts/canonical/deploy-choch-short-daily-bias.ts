/**
 * Deploy: XAU/USD CHOCH-Short + daily_bias_bearish 4h | r080 v1
 *
 * Adds the 4th algo to the live gold portfolio. Direction-diversification:
 * the existing 3 are all Long; this one is Short.
 *
 * Evidence (comprehensive-daily-bias-sweep + four-algo-with-short-stress):
 *   - Layer A baseline + daily_bias_bearish: 45 trades, WR 37.8%, DD 4.97%,
 *     daily_DD 1.21%, Sharpe 0.27, +21R — the ONLY 4h Short with daily_bias
 *     passing all hard FTMO+operator gates
 *   - Pairwise Pearson vs deployed 3: -0.023, -0.023, -0.038 (near-zero)
 *   - 4-algo stress at 0.80% risk: worst Max Loss 9.20% (vs 10.86% 3-algo),
 *     zero breaches (vs 3 ML breaches 3-algo), avg return +3.56% vs +3.24%
 *
 * Config matches the other 3 Deploy:* algos:
 *   - capital $100,000 (FTMO Test $100K)
 *   - risk_per_trade 0.80%
 *   - broker_connection_id c508808c-... (FTMO Test $100k MetaApi MT5)
 *   - live_trading_enabled = true
 *   - prop_firm max_dd=10, daily_loss_limit=5, combined_risk_cap_pct=4
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

const SRC_ID = "9d5bbb17-24a7-42bb-9393-ebfa06e2b6f1"; // Search: XAU/USD CHOCH-Short 4h
const NEW_NAME = "Deploy: XAU/USD CHOCH-Short+DailyBias 4h | r080 v1";
const NEW_CAPITAL = 100_000;
const RISK_PCT = 0.80;
const BROKER_ID = "c508808c-e799-444e-a34e-47c36af23bc4";

async function main(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const sb = createClient<Database>(url, key);

  // Idempotency: skip if already deployed
  const { data: existing } = await sb.from("algorithms").select("id, name").eq("name", NEW_NAME).maybeSingle();
  if (existing) {
    console.log(`Already deployed: ${NEW_NAME} (id=${existing.id})`);
    return;
  }

  // Fetch source algo
  const { data: src, error: srcErr } = await sb.from("algorithms").select("*").eq("id", SRC_ID).maybeSingle();
  if (srcErr || !src) throw new Error(`source algo ${SRC_ID} not found: ${srcErr?.message}`);
  const baseRules = src.rules as unknown as AlgorithmRules;

  // Construct augmented rules: choch-bearish + daily_bias-bearish, logic=all
  const augmentedEC: EntryCondition[] = [
    ...baseRules.entry_conditions,
    { type: "pattern", pattern: "daily_bias", direction: "bearish", ma_period: 20, timeframe: "1d" } as EntryCondition,
  ];
  const rules: AlgorithmRules = {
    ...baseRules,
    entry_conditions: augmentedEC,
    entry_logic: "all",
    position_sizing: { type: "risk_per_trade", value: RISK_PCT },
    prop_firm: {
      max_drawdown: 10,
      daily_loss_limit: 5,
      combined_risk_cap_pct: 4,
      slippage_bps: 0.5,
      spread_bps: 0.4,
    } as never,
    news_veto: { enabled: true, minutes_before: 15, minutes_after: 30, impact_levels: ["high"] } as never,
  };

  // Insert new algo (schema match: deploy-multi-algo-portfolio.ts pattern)
  const { data: inserted, error: insErr } = await sb.from("algorithms").insert({
    user_id: src.user_id,
    name: NEW_NAME,
    asset_class: src.asset_class,
    strategy_id: src.strategy_id,
    capital: NEW_CAPITAL,
    leverage: src.leverage,
    status: "active",
    live_trading_enabled: true,
    broker_connection_id: BROKER_ID,
    rules: rules as never,
    backtest_results: {
      computed_at: new Date().toISOString(),
      source: "deploy-choch-short-daily-bias.ts",
      deploy_doc: "g6-4th-algo-direction-diversifier-2026-06-29-night-plus-4",
      base_source_algo: "Search: XAU/USD CHOCH-Short 4h",
      augmentation: "daily_bias_bearish (logic=all)",
      risk_per_trade: RISK_PCT,
      portfolio_role: "4th algo / direction-diversifier (Short) in 4-algo gold portfolio @ 0.80% each",
      expected_combined_monthly_return_pct_4algo: 1.78,
      expected_combined_worst_max_loss_pct_4algo: 9.20,
      expected_combined_worst_daily_pct_4algo: 3.56,
      expected_combined_pass_rate_pct_4algo: 21.7,
      expected_combined_breaches_4algo: 0,
      pairwise_pearson_vs_arb_r3: -0.023,
      pairwise_pearson_vs_engulfing: -0.023,
      pairwise_pearson_vs_arb_r25: -0.038,
    } as never,
  }).select("id").single();
  if (insErr || !inserted) throw new Error(`insert failed: ${insErr?.message}`);

  // Insert watchlist row
  const { error: wlErr } = await sb.from("algorithm_watchlist").insert({
    algorithm_id: inserted.id,
    user_id: src.user_id,
    ticker: "XAU/USD",
    added_by: "ai",
  });
  if (wlErr) {
    await sb.from("algorithms").delete().eq("id", inserted.id);
    throw new Error(`watchlist insert failed: ${wlErr.message}`);
  }

  console.log(`✓ Deployed: ${NEW_NAME}`);
  console.log(`  id           : ${inserted.id}`);
  console.log(`  capital      : $${NEW_CAPITAL}`);
  console.log(`  risk         : ${RISK_PCT}%`);
  console.log(`  broker       : ${BROKER_ID} (FTMO Test $100k)`);
  console.log(`  live_trading : true`);
  console.log(`  status       : active`);
  console.log("");
  console.log("Next scan tick → engine will evaluate this algo on next 4h close.");
  console.log("Verify portfolio state:");
  console.log("  pnpm dlx tsx scripts/canonical/broker-mirror-readiness-check.ts");
}

main().catch((e) => { console.error(e); process.exit(1); });
