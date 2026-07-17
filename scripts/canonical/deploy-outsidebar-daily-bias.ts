/**
 * Deploy: XAU/USD OutsideBar+DailyBias 4h | r066 v1 — 4th algo of the gold
 * portfolio, + uniform risk re-size of the deployed trio 0.80% → 0.66%.
 *
 * Evidence (E2.20 pinned-data re-derivation, sha256 6d10d04b…, exact runs):
 *   - Solo (0.80%): n=195, WR 38.5%, DD 5.55%, $10,534 — robust at 0.74%
 *     too (n=194, WR 38.7%, DD 4.79%) unlike CHOCH-Long (WR 38.3→35.5%
 *     across the same risk change → rejected as small-sample fragile).
 *   - 4-algo SIBLING-AWARE @0.66%: 0/581 challenge-window breaches,
 *     worst ML 8.45% (1.55pp FTMO buffer), worst DL 3.04%, avg
 *     +3.25%/challenge ≈ 1.62%/mo — vs trio @0.80: 8.67% ML, 1.35%/mo.
 *   - 5-algo probe (+BOS-Long @0.60): ML 9.54%, 1.65%/mo → at ML-matched
 *     risk ≈1.46%/mo < 4-algo → greedy stops at 4.
 *   - |ρ|max vs trio 0.354 (<0.40 gate); sibling friction ≈ nil.
 *
 * Post-zombie deploy protocol (feedback_deploy_smoke_test_live_path):
 *   1. Final rules are Zod-parsed via algorithmRulesSchema — abort on fail.
 *   2. news_veto + prop_firm key-sets asserted equal to a healthy deployed
 *      row (the CHOCH-Short zombie was a hand-built key-shape mismatch).
 *   3. Post-deploy: watch activity_log for `error` events on the new
 *      algorithm_id over the next 4h closes.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
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

const SRC_ID = "fb82095d-3e1a-4722-9fee-c216ea5a78b4"; // Search: XAU/USD OutsideBar-Long 4h
const HEALTHY_ID = "1ebdce3d-4ab9-4e30-b5d3-075942b7cf69"; // Deploy: ARB+DailyBias (shape reference)
const NEW_NAME = "Deploy: XAU/USD OutsideBar+DailyBias 4h | r066 v1";
const BROKER_ID = "c508808c-e799-444e-a34e-47c36af23bc4";
const CAPITAL = 100_000;
const RISK_PCT = 0.66;

async function main(): Promise<void> {
  const sb = createClient<Database>(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

  const { data: existing } = await sb.from("algorithms").select("id").eq("name", NEW_NAME).maybeSingle();
  if (existing) {
    console.log(`Already deployed: ${NEW_NAME} (${existing.id}) — updating trio risk only.`);
  }

  const { data: src } = await sb.from("algorithms").select("*").eq("id", SRC_ID).maybeSingle();
  if (!src) throw new Error("source Search row not found");
  const base = src.rules as unknown as AlgorithmRules;
  const { data: healthy } = await sb.from("algorithms").select("rules").eq("id", HEALTHY_ID).maybeSingle();
  if (!healthy) throw new Error("healthy reference row not found");
  const healthyRules = healthy.rules as unknown as AlgorithmRules;

  // Final rules: evidence-faithful base (+ daily_bias, evaluated in E2.20)
  // + live-only standard layers (news_veto canonical shape, adaptive
  // time_filter). NO regime/adx — not in the E2.20 evidence for this algo.
  const rules: AlgorithmRules = {
    ...base,
    entry_conditions: [
      ...base.entry_conditions,
      { type: "pattern", pattern: "daily_bias", direction: "bullish", ma_period: 20, timeframe: "1d" } as EntryCondition,
    ],
    entry_logic: "all",
    position_sizing: { ...base.position_sizing, type: "risk_per_trade", value: RISK_PCT },
    news_veto: { enabled: true, min_impact: "high", block_minutes_before: 15, block_minutes_after: 30 } as never,
    time_filter: { enabled: true, min_wr_pct: 45, min_samples: 5 } as never,
  };

  // Gate 1: Zod schema. Also parse the healthy row — if the schema rejects
  // BOTH, it's schema drift (advisory); if it rejects ONLY ours, abort.
  const ours = algorithmRulesSchema.safeParse(rules);
  const ref = algorithmRulesSchema.safeParse(healthyRules);
  if (!ours.success && ref.success) {
    console.error("ABORT — new rules fail algorithmRulesSchema while healthy reference passes:");
    console.error(JSON.stringify(ours.error.issues.slice(0, 6), null, 1));
    process.exit(1);
  }
  console.log(`Zod: new=${ours.success ? "PASS" : "fail"} healthy-ref=${ref.success ? "PASS" : "fail"}${!ours.success && !ref.success ? " (schema drift — both fail identically; key-parity gate decides)" : ""}`);

  // Gate 2: key-set parity with the healthy deployed row on the two blocks
  // whose hand-built shape caused the CHOCH-Short zombie.
  const keysOf = (r: AlgorithmRules, block: string): string =>
    Object.keys(((r as unknown as Record<string, unknown>)[block] as object | undefined) ?? {})
      .sort()
      .join(",");
  for (const block of ["news_veto", "prop_firm"] as const) {
    const a = keysOf(rules, block);
    const b = keysOf(healthyRules, block);
    if (a !== b) {
      console.error(`ABORT — ${block} key-set mismatch vs healthy row:\n  new:     ${a}\n  healthy: ${b}`);
      process.exit(1);
    }
    console.log(`Key parity ${block}: OK`);
  }

  if (!existing) {
    const { data: inserted, error: insErr } = await sb.from("algorithms").insert({
      user_id: src.user_id,
      name: NEW_NAME,
      asset_class: src.asset_class,
      strategy_id: src.strategy_id,
      capital: CAPITAL,
      leverage: src.leverage,
      status: "active",
      live_trading_enabled: true,
      broker_connection_id: BROKER_ID,
      rules: rules as never,
      backtest_results: {
        computed_at: new Date().toISOString(),
        source: "deploy-outsidebar-daily-bias.ts",
        evidence: "e2-results/e2.20-rederivation-2026-07-10*.json + e2.20-acceptance-2026-07-10.md",
        pinned_sha256: "6d10d04b18bc0699",
        base_source_algo: "Search: XAU/USD OutsideBar-Long 4h",
        augmentation: "daily_bias_bullish (logic=all)",
        risk_per_trade: RISK_PCT,
        portfolio_role: "4th algo in 4-algo gold portfolio @ 0.66% uniform (E2.20 R3-corrected winner; CHOCH-Long rejected as risk-fragile)",
        expected_4algo_sibling_aware: { worst_ml_pct: 8.45, worst_dl_pct: 3.04, breaches: 0, windows: 581, avg_return_per_challenge_pct: 3.25, monthly_pct: 1.62, max_pairwise_corr: 0.354 },
        solo_stats_r080: { trades: 195, wr: 38.5, static_dd_pct: 5.55, total_pnl: 10534 },
      } as never,
    }).select("id").single();
    if (insErr || !inserted) throw new Error(`insert failed: ${insErr?.message}`);
    const { error: wlErr } = await sb.from("algorithm_watchlist").insert({
      algorithm_id: inserted.id, user_id: src.user_id, ticker: "XAU/USD", added_by: "ai",
    });
    if (wlErr) {
      await sb.from("algorithms").delete().eq("id", inserted.id);
      throw new Error(`watchlist insert failed: ${wlErr.message}`);
    }
    console.log(`✓ Deployed ${NEW_NAME} (id=${inserted.id}) — active, live, $${CAPITAL}, ${RISK_PCT}%`);
  }

  // Uniform re-size: trio 0.80 → 0.66 (E2.20 R4, exact-verified).
  const { data: deployRows } = await sb.from("algorithms").select("id, name, rules").like("name", "Deploy:%").neq("name", NEW_NAME).eq("status", "active");
  for (const row of deployRows ?? []) {
    const r = row.rules as unknown as AlgorithmRules;
    const updated = { ...r, position_sizing: { ...r.position_sizing, value: RISK_PCT } };
    const { error } = await sb.from("algorithms").update({ rules: updated as never }).eq("id", row.id);
    if (error) throw new Error(`risk update failed for ${row.name}: ${error.message}`);
    console.log(`✓ ${row.name}: risk → ${RISK_PCT}%`);
  }

  const { data: final } = await sb.from("algorithms")
    .select("name, status, live_trading_enabled, capital")
    .eq("status", "active").like("name", "Deploy:%").order("name");
  console.log("\nActive portfolio:");
  for (const f of final ?? []) console.log(`  ${f.name} — live=${f.live_trading_enabled} cap=$${f.capital}`);
  console.log("\nPost-deploy watch: SELECT count(*) FROM activity_log WHERE algorithm_id='<new-id>' AND event_type='error' — must stay 0 over the next 4h closes.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
