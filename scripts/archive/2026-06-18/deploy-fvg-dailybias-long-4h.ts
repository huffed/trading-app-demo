/**
 * Deploy `Library: Gold FVG-DailyBias-Long 4h` — S1.5 priority #1.
 *
 * First "validated-primitive composition" algo. Friend-replay (2026-06-16,
 * see project_friend_replay_2026_06) ranked daily_bias (73% W, 44% L) and
 * FVG (45% W, 6% L) as the two strongest WINNER-discriminator primitives
 * across his 38 FTMO trades. This algo composes them on 4h: a 4h bullish
 * FVG that closes while D1 SMA20 also reads bullish.
 *
 * Modeled after the active library 4h longs (Coil-Breakout 4h = bos+daily_bias,
 * Dip-Buyer 4h = liquidity_sweep+daily_bias). Same SL/TP geometry, same
 * prop-firm envelope, same risk sizing. Only deltas: entry_conditions uses
 * fvg (not bos / sweep) + explicit entry_logic: "all".
 *
 * Includes V1.2 cluster gate as shadow (block_joint mode, shadow:true) per
 * the live deployment on Coil-Breakout 1h and FVG-Long 30m. This algo
 * is NOT a "let it run unfiltered for V1.x mining" deploy (that was
 * OTE-Long); it's a "compose two validated primitives and observe under
 * the same shadow-gate telemetry as its sister algos" deploy.
 *
 * Safety:
 *   - DRY RUN by default. Pass APPLY=1 to actually insert.
 *   - Idempotent: refuses to insert if an algo with the same name exists.
 *   - PAPER-ONLY: live_trading_enabled=false, broker_connection_id=null.
 *   - Seeds watchlist with XAU/USD; scan cron picks up the new algo on
 *     its next 15-min tick.
 *
 * Env required in .env.local:
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * Usage:
 *   pnpm dlx tsx scripts/deploy-fvg-dailybias-long-4h.ts            # dry run
 *   APPLY=1 pnpm dlx tsx scripts/deploy-fvg-dailybias-long-4h.ts    # commit
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
const NAME = "Library: Gold FVG-DailyBias-Long 4h";
const TICKER = "XAU/USD";

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
  // rr=2 (not the rr=3 sister algos use) — geometry sweep
  // (scripts/sweep-fvg-dailybias-geometry.ts) found rr=2 monotonically
  // beats rr=3 and rr=5 across the {3,4,6} lookback grid AND specifically
  // rescues the chop-year failure mode (2021: +$2.4K rr=2 vs -$6.9K rr=3).
  // Mechanism: in sideways markets price reverses within 2R before
  // completing a 3R move — rr=2 TPs trigger, rr=3 TPs don't. Positive
  // every single year of the 6yr corpus. Trades portfolio A/B alignment
  // with sister algos for material profitability gain on this strategy.
  take_profit: { type: "rr_multiple" as const, value: 2 },
  max_positions: 1,
  stagnant_exit: { enabled: true },
  exit_conditions: [] as unknown[],
  position_sizing: { type: "risk_per_trade" as const, value: 0.6 },
  entry_conditions: [
    {
      type: "pattern" as const,
      pattern: "fvg" as const,
      direction: "bullish" as const,
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
  entry_logic: "all" as const,
  market_state_gate: {
    mode: "block_joint" as const,
    shadow: true,
    states: {
      range: ["compressed"],
      entry_zone: ["discount"],
      entry_hour_bucket: ["london(7-13)"],
    },
    on_unreadable: "allow" as const,
  },
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

  const { data: existing, error: existingErr } = await supabase
    .from("algorithms")
    .select("id, status")
    .eq("user_id", userId)
    .eq("name", NAME)
    .maybeSingle();
  if (existingErr) throw new Error(`existence check failed: ${existingErr.message}`);
  if (existing) {
    console.log(
      `\n✓ algorithm "${NAME}" ALREADY EXISTS (id=${existing.id.slice(0, 8)}…, status=${existing.status}). Skipping insert.`
    );
    return;
  }

  console.log("\nProposed insert:");
  console.log(`  name: ${NAME}`);
  console.log(`  status: active`);
  console.log(`  live_trading_enabled: false  (paper-only)`);
  console.log(`  broker_connection_id: null`);
  console.log(`  rules: ${JSON.stringify(RULES, null, 2)}`);

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
        "Paper-only composition algo: 4h bullish FVG + D1 SMA20 bullish bias. Tests whether two validated WINNER-discriminator primitives (per friend-replay 2026-06-16) compose into a tradeable setup. V1.2 cluster gate runs in shadow.",
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
      "First entry depends on a 4h bar closing inside a bullish FVG while D1 reads above its 20-SMA. " +
      "Expect ~weeks to first close given dual-condition gating."
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
