/**
 * Deploy: XAU/USD Engulfing25+DailyBias 4h | r042 v1 — 5th algo of the gold
 * portfolio + uniform re-size of all five to 0.42% (worst-window ML = 8.0
 * under the E2.24.d complete-fidelity harness).
 *
 * Evidence (E2.24.d re-derivation + E2.27 MC, pinned sha 6d10d04b…):
 *   - 5-algo sibling-aware @0.60: avgRet 1.58%/ch, worst ML 11.50%, worst
 *     DL 4.77%, 2/576 window breaches → ML-equalized to 8.0: risk 0.417%
 *     (deployed as 0.42) ≈ 0.55%/mo — the ML-equalized WINNER (4-algo
 *     0.38%/mo; +BOS excluded on DL profile: 6.20% worst DL, 8 breaches).
 *   - The prior S3 "additions rejected" was a fixed-0.60%-risk-cap
 *     artifact (E2.25.j): at EQUAL tail risk the addition wins.
 *   - MtM-ρ gate (E2.24.f.v upgrade — daily floating-equity deltas, not
 *     exit-day Pearson): |ρ|max 0.375 vs Engulfing rr3_lb6 — PASSES <0.40
 *     (borderline; monitored as a G.8 watch item).
 *   - E2.27 MC (10k block-resampled challenges): tail ml_p95 16.90 @0.60;
 *     at 0.42: P(ML>10 FTMO breach) ≈ 8%/challenge-to-resolution. Demo
 *     breach cost = evidence-clock restart (not money); the stricter
 *     P-rule sizing (~0.28%) is filed as REAL-challenge input (Stage 5.3).
 *   - Evidence cadence: 5th stream raises portfolio trade rate ~25% →
 *     M1's 30 trades ≈ 1 month sooner.
 *
 * Post-zombie deploy protocol (feedback_deploy_smoke_test_live_path):
 *   1. Rules Zod-parsed via algorithmRulesSchema — abort on fail.
 *   2. news_veto + prop_firm key-parity vs a healthy deployed row (the
 *      CHOCH-Short zombie class). Blocks are COPIED from the healthy row,
 *      so parity holds by construction — the assert guards drift.
 *   3. broker_connection_id + portfolio_id sourced FROM the healthy row
 *      (the older deploy script hardcoded a now-dead connection).
 *   4. Post-deploy: watch activity_log for `error` on the new algorithm_id
 *      over the next 4h closes.
 *
 * Evidence-clock rule: incumbents' per-algo clocks CONTINUE (risk-only
 * rescale); the PORTFOLIO G.8 baseline re-baselines to the 5-algo
 * configuration from deploy date (addition re-baselines portfolio only).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { enumerateLayerBVariants } from "../../src/lib/algo-search/layer-b-enumerate";
import { algorithmRulesSchema } from "../../src/lib/validators/algorithm";
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

const SRC_NAME = "Search: XAU/USD Engulfing-Long 4h";
const VARIANT_TAG = "rr25_lb4_r06_rf0_af0";
const HEALTHY_NAME = "Deploy: XAU/USD OutsideBar+DailyBias 4h | rr3_lb3 r066 v2";
const NEW_NAME = "Deploy: XAU/USD Engulfing25+DailyBias 4h | r042 v1";
const CAPITAL = 100_000;
const RISK_PCT = 0.42;

async function main(): Promise<void> {
  const sb = createClient<Database>(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

  const { data: existing } = await sb.from("algorithms").select("id").eq("name", NEW_NAME).maybeSingle();
  const { data: src } = await sb.from("algorithms").select("*").eq("name", SRC_NAME).maybeSingle();
  if (!src) throw new Error(`source row not found: ${SRC_NAME}`);
  const { data: healthy } = await sb
    .from("algorithms")
    .select("rules, broker_connection_id, portfolio_id, strategy_id, asset_class, leverage, user_id")
    .eq("name", HEALTHY_NAME)
    .maybeSingle();
  if (!healthy) throw new Error(`healthy reference row not found: ${HEALTHY_NAME}`);
  const healthyRules = healthy.rules as unknown as AlgorithmRules;
  if (!healthy.broker_connection_id) throw new Error("healthy row has no broker connection — refusing to deploy unmirrored");
  if (!healthy.portfolio_id) throw new Error("healthy row has no portfolio_id — the account-level halt would skip the new algo");

  // Exact enumerated geometry (the E2.24.d evidence variant), + daily_bias.
  const base = src.rules as unknown as AlgorithmRules;
  const variant = enumerateLayerBVariants({ name: SRC_NAME, ticker: "XAU/USD", capital: CAPITAL, rules: base }).find(
    (v) => v.variant_tag === VARIANT_TAG
  );
  if (!variant) throw new Error(`variant ${VARIANT_TAG} not enumerated`);
  const hasBias = variant.rules.entry_conditions.some((c) => (c as { pattern?: string }).pattern === "daily_bias");
  const rules: AlgorithmRules = {
    ...variant.rules,
    entry_conditions: hasBias
      ? variant.rules.entry_conditions
      : [
          ...variant.rules.entry_conditions,
          { type: "pattern", pattern: "daily_bias", direction: "bullish", ma_period: 20, timeframe: "1d" } as EntryCondition,
        ],
    entry_logic: "all",
    position_sizing: { ...variant.rules.position_sizing, type: "risk_per_trade", value: RISK_PCT },
    // Live-canonical blocks copied from the healthy deployed row — key
    // parity vs live by construction (the zombie class was hand-built
    // shapes drifting from what the scan path parses).
    news_veto: healthyRules.news_veto,
    time_filter: healthyRules.time_filter,
    prop_firm: healthyRules.prop_firm,
    stagnant_exit: healthyRules.stagnant_exit,
  };

  // Gate 1: Zod.
  const ours = algorithmRulesSchema.safeParse(rules);
  const ref = algorithmRulesSchema.safeParse(healthyRules);
  if (!ours.success && ref.success) {
    console.error("ABORT — new rules fail algorithmRulesSchema while healthy reference passes:");
    console.error(JSON.stringify(ours.error.issues.slice(0, 6), null, 1));
    process.exit(1);
  }
  console.log(`Zod: new=${ours.success ? "PASS" : "fail"} healthy-ref=${ref.success ? "PASS" : "fail"}`);

  // Gate 2: key-set parity on the zombie-class blocks.
  const keysOf = (r: AlgorithmRules, block: string): string =>
    Object.keys(((r as unknown as Record<string, unknown>)[block] as object | undefined) ?? {})
      .sort()
      .join(",");
  for (const block of ["news_veto", "prop_firm"] as const) {
    const a = keysOf(rules, block);
    const b = keysOf(healthyRules, block);
    if (a !== b) {
      console.error(`ABORT — ${block} key-set mismatch:\n  new:     ${a}\n  healthy: ${b}`);
      process.exit(1);
    }
    console.log(`Key parity ${block}: OK`);
  }

  if (!existing) {
    const { data: inserted, error: insErr } = await sb
      .from("algorithms")
      .insert({
        user_id: healthy.user_id,
        name: NEW_NAME,
        asset_class: healthy.asset_class,
        strategy_id: src.strategy_id,
        capital: CAPITAL,
        leverage: healthy.leverage,
        status: "active",
        live_trading_enabled: true,
        broker_connection_id: healthy.broker_connection_id,
        portfolio_id: healthy.portfolio_id,
        rules: rules as never,
        backtest_results: {
          computed_at: new Date().toISOString(),
          source: "deploy-engulfing-rr25-addition.ts",
          evidence: "e2-results/e2.24d-rederivation-2026-07-17.md + e2.27 MC (mc-decision log) + MODE=rederive",
          pinned_sha256: "6d10d04b18bc0699",
          base_source_algo: SRC_NAME,
          variant_tag: VARIANT_TAG,
          augmentation: "daily_bias_bullish (logic=all)",
          risk_per_trade: RISK_PCT,
          portfolio_role:
            "5th algo — ML-equalized winner (E2.24.d.vi): 5-algo @0.42 ≈ 0.55%/mo at worst-window ML 8.0; MtM-ρ 0.375 (<0.40, borderline — G.8 watch item); +BOS excluded on DL profile",
          expected_5algo_sibling_aware: {
            at_risk_060: { worst_ml_pct: 11.5, worst_dl_pct: 4.77, breaches: 2, windows: 576, avg_return_per_challenge_pct: 1.58 },
            deployed_042: { worst_ml_pct: 8.05, monthly_pct: 0.55 },
            mc_10k: { tail_ml_p95_at_060: 16.9, p_pass_at_pstar: 97.4, mtm_rho_max: 0.375 },
          },
        } as never,
      })
      .select("id")
      .single();
    if (insErr || !inserted) throw new Error(`insert failed: ${insErr?.message}`);
    const { error: wlErr } = await sb.from("algorithm_watchlist").insert({
      algorithm_id: inserted.id,
      user_id: healthy.user_id,
      ticker: "XAU/USD",
      added_by: "ai",
    });
    if (wlErr) {
      await sb.from("algorithms").delete().eq("id", inserted.id);
      throw new Error(`watchlist insert failed: ${wlErr.message}`);
    }
    console.log(`✓ Deployed ${NEW_NAME} (id=${inserted.id}) — active, live, $${CAPITAL}, ${RISK_PCT}%, portfolio=${healthy.portfolio_id.slice(0, 8)}`);
  } else {
    console.log(`Already deployed: ${NEW_NAME} — proceeding to uniform re-size only.`);
  }

  // Uniform re-size: ALL active Deploy rows → 0.42% (E2.24.d ML≤8 for the
  // 5-algo configuration; risk-only rescale = no per-algo clock reset).
  const { data: deployRows } = await sb.from("algorithms").select("id, name, rules").like("name", "Deploy:%").eq("status", "active");
  for (const row of deployRows ?? []) {
    const r = row.rules as unknown as AlgorithmRules;
    if (r.position_sizing?.value === RISK_PCT) continue;
    const updated = { ...r, position_sizing: { ...r.position_sizing, value: RISK_PCT } };
    const { error } = await sb.from("algorithms").update({ rules: updated as never, updated_at: new Date().toISOString() }).eq("id", row.id);
    if (error) throw new Error(`risk update failed for ${row.name}: ${error.message}`);
    console.log(`✓ ${row.name}: risk → ${RISK_PCT}%`);
  }

  const { data: final } = await sb
    .from("algorithms")
    .select("name, live_trading_enabled, capital, portfolio_id, rules")
    .eq("status", "active")
    .like("name", "Deploy:%")
    .order("name");
  console.log("\nActive portfolio:");
  for (const f of final ?? []) {
    const r = f.rules as unknown as AlgorithmRules;
    console.log(`  ${f.name} — live=${f.live_trading_enabled} cap=$${f.capital} risk=${r.position_sizing?.value}% pf=${f.portfolio_id?.slice(0, 8)}`);
  }
  console.log("\nNEXT: watch activity_log for `error` events on the new algo over the next 4h closes (zombie protocol step 3).");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
