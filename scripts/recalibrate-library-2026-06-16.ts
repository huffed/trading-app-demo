/**
 * Library recalibration 2026-06-16 PM.
 *
 * Per the trade-flow diagnostic + per-algo validation + cluster-filter
 * rescue check, this script:
 *
 *   1. PAUSES `Library: Gold Bear-Short Sentinel 4h` — zero gold trades
 *      in 6 years of corpus (`scripts/discovery-per-algo-validation-...`).
 *      Reversible: status=paused, config preserved for future S5 forex
 *      deployment.
 *
 *   2. DEPLOYS `Library: Gold Coil-Breakout 4h` paper-only — the only
 *      undeployed V1.2 spec to validate at the 10% DD gate (n=35,
 *      mean_R=+0.056, DD=5.83%). Marginal positive expectancy; trade-flow
 *      contribution ~6/year on gold. Live, paper-only.
 *
 * NOT touched here (covered elsewhere):
 *   - dip_buyer_4h stays deployed (cluster gate rescue validated)
 *   - fvg_long_30m + coil_breakout_1h stay (already-positive)
 *   - Gold Swing 4h flagship untouched
 *   - OTE-Long 4h untouched (still accumulating)
 *
 * Safety:
 *   - DRY RUN by default. Pass APPLY=1 to commit.
 *   - Idempotent: skips paused→paused and existing-name re-inserts.
 */
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";

{
  try {
    const raw = readFileSync(".env.local", "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (!m) continue;
      const [, k, v] = m;
      if (!process.env[k]) process.env[k] = v.replace(/^['"]|['"]$/g, "");
    }
  } catch { /* ignore */ }
}

const APPLY = process.env.APPLY === "1";
const BEAR_SHORT_ID = "20654d20-1b6b-4f71-8099-fd3294a0ef1f";
const NEW_NAME = "Library: Gold Coil-Breakout 4h";
const TICKER = "XAU/USD";

// Mirrors coil_breakout_4h spec from V1.2 mining script.
// SL: swing_anchor 0.1/4. TP: rr_multiple 3. Long-only. Existing
// market_state_gate: allow when range=compressed (which is the original
// V1.2 spec's gate — preserve it on deploy).
const COIL4_RULES = {
  side: "long" as const,
  leverage: 9,
  prop_firm: {
    spread_bps: 5,
    max_drawdown: 10,
    slippage_bps: 10,
    profit_target: 10,
    commission_pct: 0,
    consistency_rule: 0,
    daily_loss_limit: 5,
    combined_risk_cap_pct: 4,
    max_consecutive_losses: 0,
    consecutive_loss_daily_halt: 2,
  },
  stop_loss: { type: "swing_anchor" as const, value: 0.1, lookback: 4 },
  timeframe: "4h",
  asset_class: "commodity",
  take_profit: { type: "rr_multiple" as const, value: 3 },
  max_positions: 1,
  stagnant_exit: { enabled: true },
  exit_conditions: [] as unknown[],
  position_sizing: { type: "risk_per_trade" as const, value: 0.6 },
  entry_conditions: [
    {
      type: "pattern" as const,
      pattern: "bos" as const,
      direction: "bullish" as const,
      lookback: 5,
      timeframe: "4h",
    },
    {
      type: "pattern" as const,
      pattern: "daily_bias" as const,
      direction: "bullish" as const,
      ma_period: 20,
      timeframe: "4h",
    },
  ],
  market_state_gate: {
    mode: "allow" as const,
    states: { range: ["compressed"] as const },
    on_unreadable: "allow" as const,
  },
};

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) throw new Error("env missing");
  const supabase = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

  console.log(`Mode: ${APPLY ? "APPLY" : "DRY RUN"}\n`);

  // --- Step 1: pause bear_short_4h ---
  console.log("--- Step 1: PAUSE Library: Gold Bear-Short Sentinel 4h ---");
  const { data: bear, error: bearReadErr } = await supabase
    .from("algorithms")
    .select("id, name, status")
    .eq("id", BEAR_SHORT_ID)
    .maybeSingle();
  if (bearReadErr || !bear) throw new Error(`read bear_short failed: ${bearReadErr?.message ?? "not found"}`);
  console.log(`  current: name="${bear.name}" status="${bear.status}"`);
  if (bear.status === "paused") {
    console.log("  ✓ already paused — skipping");
  } else {
    if (!APPLY) {
      console.log("  (dry run — would set status=paused)");
    } else {
      const { error: upErr } = await supabase.from("algorithms").update({ status: "paused" }).eq("id", BEAR_SHORT_ID);
      if (upErr) throw new Error(`pause failed: ${upErr.message}`);
      console.log("  ✓ paused");
    }
  }

  // --- Step 2: deploy coil_breakout_4h ---
  console.log("\n--- Step 2: DEPLOY Library: Gold Coil-Breakout 4h (paper-only) ---");
  // Resolve user_id from an existing library algo.
  const { data: anyLib, error: libErr } = await supabase
    .from("algorithms")
    .select("user_id")
    .like("name", "Library: %")
    .eq("status", "active")
    .limit(1)
    .maybeSingle();
  if (libErr || !anyLib) throw new Error(`could not resolve user_id: ${libErr?.message ?? "no library algo"}`);
  const userId = anyLib.user_id as string;
  console.log(`  resolved user_id: ${userId}`);

  const { data: existing, error: existsErr } = await supabase
    .from("algorithms")
    .select("id, status")
    .eq("user_id", userId)
    .eq("name", NEW_NAME)
    .maybeSingle();
  if (existsErr) throw new Error(`exists check failed: ${existsErr.message}`);
  if (existing) {
    console.log(`  ✓ "${NEW_NAME}" already exists (id=${existing.id.slice(0, 8)}…, status=${existing.status}) — skipping`);
  } else {
    console.log(`  proposed rules: ${JSON.stringify(COIL4_RULES)}`);
    if (!APPLY) {
      console.log("  (dry run — would INSERT)");
    } else {
      const { data: ins, error: insErr } = await supabase
        .from("algorithms")
        .insert({
          user_id: userId,
          name: NEW_NAME,
          description:
            "Paper-only coil-breakout on 4h gold (BOS + daily_bias bullish, allow-mode range=compressed gate). Validated at 10% DD gate from V1.2 corpus (n=35, mean_R=+0.056, DD=5.83% on gold). Marginal positive expectancy; deployed to expand trade-flow.",
          status: "active",
          live_trading_enabled: false,
          broker_connection_id: null,
          rules: COIL4_RULES,
        })
        .select("id")
        .single();
      if (insErr || !ins) throw new Error(`insert failed: ${insErr?.message ?? "no row"}`);
      console.log(`  ✓ inserted algorithm id=${ins.id}`);

      const { error: wlErr } = await supabase.from("algorithm_watchlist").insert({
        user_id: userId,
        algorithm_id: ins.id,
        ticker: TICKER,
        added_by: "user",
      });
      if (wlErr) console.error(`  ⚠️  watchlist insert failed: ${wlErr.message}`);
      else console.log(`  ✓ watchlist seeded with ${TICKER}`);
    }
  }

  console.log("\n=== Done ===");
  console.log(APPLY ? "Both changes committed." : "Dry run complete. Re-run with APPLY=1.");
}

main().catch((e) => { console.error(e); process.exit(1); });
