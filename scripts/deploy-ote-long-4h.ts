/**
 * Deploy `Library: Gold OTE-Long 4h` — closes #249.
 *
 * Tier-2 follow-on. PR #238 built the OTE detector (62-79% fib
 * retracement of prior leg) at src/lib/patterns/ote.ts but no algo
 * uses it as an entry trigger. Without one, OTE-tagged trades will
 * never accumulate at scale and V1.x mining can't surface an OTE-driven
 * cluster.
 *
 * Modeled after `Library: Gold FVG-Long 30m` (active since 2026-06-15):
 *   - Same user_id, same prop_firm config, same RISK_PCT, same
 *     SL/TP geometry (swing_anchor 0.10/4 + rr_multiple 3).
 *   - Long-only (per feedback_auto_side_asymmetry — validate one side
 *     first before considering auto/short).
 *   - PAPER-ONLY: live_trading_enabled=false, broker_connection_id=null.
 *     No accidental real-money exposure on a brand-new algo.
 *   - NO market_state_gate at deploy time. The whole point is to let
 *     OTE-tagged trades accumulate UNFILTERED so V1.3 mining can later
 *     surface OTE-conditioned clusters from the corpus.
 *
 * Side note for later: once ~50 OTE-Long trades close, re-run
 * V1.x mining with OTE as a feature to test whether the joint signature
 * (OTE ∩ entry_zone ∩ entry_hour_bucket) holds the edge OTE theory
 * predicts.
 *
 * Safety:
 *   - DRY RUN by default. Pass APPLY=1 to actually insert.
 *   - Refuses to insert if an algo with the same name already exists
 *     (idempotent via the (user_id, name) unique constraint, but we
 *     check first to give a clear error).
 *   - Seeds the watchlist with XAU/USD (no backtest run by the script;
 *     the scan cron will pick it up on its next tick).
 *
 * Env required in .env.local:
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * Usage:
 *   pnpm dlx tsx scripts/deploy-ote-long-4h.ts            # dry run
 *   APPLY=1 pnpm dlx tsx scripts/deploy-ote-long-4h.ts    # commit
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
  } catch {
    /* ignore */
  }
}

const APPLY = process.env.APPLY === "1";
const NAME = "Library: Gold OTE-Long 4h";
const TICKER = "XAU/USD";

// Copied verbatim from the active Library: Gold FVG-Long 30m config so
// the two library algos share infra (same operator user, same prop-firm
// envelope). The only deltas are: timeframe=4h, entry_conditions uses
// ote (not fvg), and no market_state_gate.
const RULES = {
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
      pattern: "ote" as const,
      direction: "bullish" as const,
      timeframe: "4h",
    },
  ],
};

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env.local"
    );
  }
  const supabase = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  console.log(
    `Mode: ${APPLY ? "APPLY (will INSERT)" : "DRY RUN (no writes)"}\n` +
      `Target name: ${NAME}\n` +
      `Watchlist seed: ${TICKER}\n`
  );

  // Find the operator's user_id by piggybacking on an existing library
  // algo. The library is single-operator so any active 'Library:' algo
  // resolves the user.
  const { data: pattern, error: patternErr } = await supabase
    .from("algorithms")
    .select("user_id")
    .like("name", "Library: %")
    .eq("status", "active")
    .limit(1)
    .maybeSingle();
  if (patternErr || !pattern) {
    throw new Error(
      `Could not resolve operator user_id from an existing 'Library:' algo: ${patternErr?.message ?? "no matching row"}`
    );
  }
  const userId = pattern.user_id as string;
  console.log(`Resolved operator user_id: ${userId}`);

  // Idempotency check.
  const { data: existing, error: existingErr } = await supabase
    .from("algorithms")
    .select("id, status")
    .eq("user_id", userId)
    .eq("name", NAME)
    .maybeSingle();
  if (existingErr) throw new Error(`existence check failed: ${existingErr.message}`);
  if (existing) {
    console.log(`\n✓ algorithm "${NAME}" ALREADY EXISTS (id=${existing.id.slice(0, 8)}…, status=${existing.status}). Skipping insert.`);
    return;
  }

  console.log("\nProposed insert:");
  console.log(`  name: ${NAME}`);
  console.log(`  status: active`);
  console.log(`  live_trading_enabled: false  (paper-only)`);
  console.log(`  broker_connection_id: null`);
  console.log(`  rules: ${JSON.stringify(RULES)}`);

  if (!APPLY) {
    console.log("\nDry run complete. Re-run with APPLY=1 to commit.");
    return;
  }

  const { data: inserted, error: insErr } = await supabase
    .from("algorithms")
    .insert({
      user_id: userId,
      name: NAME,
      description:
        "Paper-only OTE-trigger algo. Activates the OTE primitive built in PR #238 so trades accumulate for V1.3 cluster mining. No market_state_gate at deploy — accumulating an unfiltered corpus is the point.",
      status: "active",
      live_trading_enabled: false,
      broker_connection_id: null,
      rules: RULES,
    })
    .select("id")
    .single();
  if (insErr || !inserted) {
    throw new Error(`algorithm insert failed: ${insErr?.message ?? "no row returned"}`);
  }
  console.log(`✓ inserted algorithm id=${inserted.id}`);

  // Seed watchlist with XAU/USD.
  const { error: wlErr } = await supabase.from("algorithm_watchlist").insert({
    user_id: userId,
    algorithm_id: inserted.id,
    ticker: TICKER,
    added_by: "user",
  });
  if (wlErr) {
    console.error(`⚠️  watchlist insert failed: ${wlErr.message}`);
    console.error("   algorithm inserted but no watchlist row — operator must add manually.");
    return;
  }
  console.log(`✓ watchlist seeded with ${TICKER}`);

  console.log(
    "\nNext: scan cron picks up the new algo on its next 15-min tick. " +
      "First OTE-triggered entry depends on a confirmed leg + close inside " +
      "the OTE band on the 4h chart. Expect ~weeks to ~months for ≥50 closed " +
      "trades to accumulate for V1.3 mining."
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
