/**
 * Deploy `Library: USD/JPY FVG-DailyBias-Long 4h` — first S5 multi-instrument
 * deploy.
 *
 * Per PR #261 forex prep + S1.5 #6 confluence test:
 *   USD/JPY fvg+daily_bias bullish + pct-0.30 SL + rr=2 produces
 *   $108K total return over 6yr, mean R 0.598, WR 51.7%, DD 5.25% —
 *   the strongest forex candidate by total return and the strongest
 *   single cell of any tested S5 candidate.
 *
 * Triple-confluence variant (fvg+daily_bias+equal_levels) tested in
 * S1.5 #6 showed +76% mean R lift on USD/JPY but only 1/3 the total
 * return ($48K vs $108K) because the additional equal_levels filter
 * prunes too many winning trades that B0 was already capturing. Since
 * B0's DD (5.25%) is comfortably under the 10% FTMO cap, the
 * selectivity tradeoff isn't worth the lost total return.
 *
 * Modeled after `Library: Gold FVG-DailyBias-Long 4h` (deployed PR #258):
 * same entry conditions, same RR=2 (also a chop-rescue winner here),
 * same risk sizing. Deltas: ticker, asset_class=forex, geometry uses
 * percentage SL (forex-tuned) instead of swing_anchor (gold-tuned).
 *
 * The geometry change is the key S5 insight from PR #261: gold needs
 * swing_anchor (because pct-0.30 is too tight for gold's per-bar ATR);
 * forex needs pct (because swing_anchor 0.10/4 is too loose). USD/JPY
 * specifically tolerates both, but pct-0.30 is the dominant cell.
 *
 * Safety:
 *   - DRY RUN by default. APPLY=1 to commit.
 *   - PAPER-ONLY: live_trading_enabled=false. First S5 deploy — no
 *     broker exposure on a brand-new instrument.
 *   - Idempotent: refuses if an algo with the same name exists.
 *   - Seeds watchlist with USD/JPY; scan cron picks up on next tick.
 *
 * Env required:
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * Usage:
 *   pnpm dlx tsx scripts/deploy-fvg-dailybias-long-4h-usdjpy.ts        # dry run
 *   APPLY=1 pnpm dlx tsx scripts/deploy-fvg-dailybias-long-4h-usdjpy.ts
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
const NAME = "Library: USD/JPY FVG-DailyBias-Long 4h";
const TICKER = "USD/JPY";

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
  // Forex-tuned geometry: percentage 0.30% SL (not swing_anchor — gold
  // uses sa because pct-0.30 is too tight for gold's per-bar ATR; forex
  // uses pct because sa 0.10/4 is too loose). Per PR #261 sweep.
  stop_loss: { type: "percentage" as const, value: 0.3 },
  timeframe: "4h",
  asset_class: "forex",
  // rr=2 — same chop-rescue mechanism as gold FVG-DailyBias-Long 4h
  // (per PR #258 geometry sweep). In USD/JPY 6yr corpus, rr=2 was
  // tied with rr=3 / rr=5 in returns but slightly higher WR and lower DD.
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
};

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env.local");
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
  console.log(`\nExpected behavior (per PR #261 forex prep sweep):`);
  console.log(`  6yr total return: ~$108,421 (USD/JPY pct-0.30 rr=2 fvg+bias)`);
  console.log(`  6yr trade count: ~302 (~50/year)`);
  console.log(`  Win rate: ~51.7%`);
  console.log(`  Peak-to-trough DD: ~5.25% (under 10% FTMO cap)`);
  console.log(`  Per-year positive every year of 6yr corpus`);

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
        "First S5 multi-instrument deploy. FVG + D1 SMA20 bullish bias on USD/JPY 4h with forex-tuned percentage SL (0.30%) and rr=2. Per PR #261 forex prep sweep, this is the strongest single cell of any S5 candidate by total return ($108K / 6yr). PAPER-ONLY pending live validation.",
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
      "First entry depends on a 4h bar closing inside a bullish FVG while D1 reads above its 20-SMA on USD/JPY. " +
      "Expected ~50 entries/year per backtest cadence."
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
