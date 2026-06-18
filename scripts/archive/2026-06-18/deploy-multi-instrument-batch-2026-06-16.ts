/**
 * Batch deploy 8 multi-instrument paper algos identified across PRs
 * #261 (forex prep), #262 (sweep_reclaim), and #263+#264 (recent gates).
 *
 * Operator request 2026-06-16 PM (LATE×10): "we've seen success in lots
 * of places and seem to have just ignored it" — multi-instrument expansion
 * beyond just one strategy.
 *
 * Per-algo geometry chosen from the actual backtest cells (not assumed
 * uniformly). Logic:
 *   - FVG-DailyBias: rr=2 universal (chop-rescue mechanism, PR #258/261)
 *   - Coil-Breakout on JPY: rr=2 for chop-safety + matches gold sister
 *   - Dip-Buyer: pair-dependent (sweep entries can run longer → rr=5 on
 *     JPY/GBP where the cell wins, rr=3 on EUR/USD where it wins)
 *   - sweep_reclaim_dailybias: sa for gold (per PR #262 gold geometry),
 *     pct 0.50 for JPY (DD-safe cell; pct-0.30 rr=5 had DD 5.91% breach)
 *
 * Safety:
 *   - DRY RUN by default. APPLY=1 to commit.
 *   - PAPER-ONLY: live_trading_enabled=false on every insert.
 *   - Per-algo idempotency: skips inserts where name already exists.
 *   - Per-algo watchlist seed.
 *
 * Promotion to live: per `feedback_live_mirror_milestone.md`, flip to
 * live when ≥15 days + ≥5 paper trades + aggregate R within ±50% of
 * backtest expectation.
 *
 * Env required:
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * Usage:
 *   pnpm dlx tsx scripts/deploy-multi-instrument-batch-2026-06-16.ts        # dry run
 *   APPLY=1 pnpm dlx tsx scripts/deploy-multi-instrument-batch-2026-06-16.ts
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

interface DeployTarget {
  name: string;
  ticker: string;
  asset_class: "forex" | "commodity";
  entry_conditions: Array<Record<string, unknown>>;
  stop_loss: { type: "swing_anchor" | "percentage"; value: number; lookback?: number };
  rr: number;
  /** Expected 6yr backtest total $ at 0.6% risk (for description/reference). */
  expected_6yr_dollars: number;
  /** Source citation. */
  source: string;
}

const PROP_FIRM = {
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
};

function patternCond(pattern: string, opts: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "pattern",
    pattern,
    direction: "bullish",
    timeframe: "4h",
    ...opts,
  };
}

const TARGETS: DeployTarget[] = [
  // ---------- FVG-DailyBias on EUR + GBP (USD/JPY already deployed PR #264) ----------
  {
    name: "Library: EUR/USD FVG-DailyBias-Long 4h",
    ticker: "EUR/USD",
    asset_class: "forex",
    entry_conditions: [
      patternCond("fvg"),
      patternCond("daily_bias", { ma_period: 20 }),
    ],
    stop_loss: { type: "percentage", value: 0.3 },
    rr: 2,
    expected_6yr_dollars: 44310,
    source: "PR #261 forex prep — pct-0.30 rr=2 / 262 trades / 63% green / 3.55% DD",
  },
  {
    name: "Library: GBP/USD FVG-DailyBias-Long 4h",
    ticker: "GBP/USD",
    asset_class: "forex",
    entry_conditions: [
      patternCond("fvg"),
      patternCond("daily_bias", { ma_period: 20 }),
    ],
    stop_loss: { type: "percentage", value: 0.3 },
    rr: 2,
    expected_6yr_dollars: 49719,
    source: "PR #261 forex prep — pct-0.30 rr=2 / 256 trades / 81.5% green / 2.96% DD",
  },
  // ---------- Coil-Breakout on USD/JPY (JPY-specific edge — fails on EUR + GBP) ----------
  {
    name: "Library: USD/JPY Coil-Breakout-Long 4h",
    ticker: "USD/JPY",
    asset_class: "forex",
    entry_conditions: [
      patternCond("bos", { lookback: 5 }),
      patternCond("daily_bias", { ma_period: 20 }),
    ],
    stop_loss: { type: "percentage", value: 0.3 },
    rr: 2,
    expected_6yr_dollars: 30786,
    source: "PR #261 forex prep — pct-0.30 rr=2 / 312 trades / 4.10% DD; coil_breakout is JPY-specific",
  },
  // ---------- Dip-Buyer across 3 forex pairs (sweep+daily_bias) ----------
  {
    name: "Library: USD/JPY Dip-Buyer-Long 4h",
    ticker: "USD/JPY",
    asset_class: "forex",
    entry_conditions: [
      patternCond("liquidity_sweep", { lookback: 5 }),
      patternCond("daily_bias", { ma_period: 20 }),
    ],
    stop_loss: { type: "swing_anchor", value: 0.1, lookback: 4 },
    rr: 5,
    expected_6yr_dollars: 27419,
    source: "PR #261 forex prep — sa-0.10/4 rr=5 / 80 trades; dip_buyer rr=5 wins on JPY+GBP",
  },
  {
    name: "Library: EUR/USD Dip-Buyer-Long 4h",
    ticker: "EUR/USD",
    asset_class: "forex",
    entry_conditions: [
      patternCond("liquidity_sweep", { lookback: 5 }),
      patternCond("daily_bias", { ma_period: 20 }),
    ],
    stop_loss: { type: "percentage", value: 0.3 },
    rr: 3,
    expected_6yr_dollars: 14411,
    source: "PR #261 forex prep — pct-0.30 rr=3 / 48 trades; EUR's best dip_buyer cell",
  },
  {
    name: "Library: GBP/USD Dip-Buyer-Long 4h",
    ticker: "GBP/USD",
    asset_class: "forex",
    entry_conditions: [
      patternCond("liquidity_sweep", { lookback: 5 }),
      patternCond("daily_bias", { ma_period: 20 }),
    ],
    stop_loss: { type: "percentage", value: 0.3 },
    rr: 5,
    expected_6yr_dollars: 14645,
    source: "PR #261 forex prep — pct-0.30 rr=5 / 60 trades; GBP's best dip_buyer cell",
  },
  // ---------- sweep_reclaim_dailybias (new primitive PR #262) on gold + JPY ----------
  {
    name: "Library: Gold sweep_reclaim-DailyBias-Long 4h",
    ticker: "XAU/USD",
    asset_class: "commodity",
    entry_conditions: [
      patternCond("liquidity_sweep_reclaim", { lookback: 5 }),
      patternCond("daily_bias", { ma_period: 20 }),
    ],
    stop_loss: { type: "swing_anchor", value: 0.1, lookback: 4 },
    rr: 3,
    expected_6yr_dollars: 16401,
    source: "PR #262 sweep_reclaim — sa-0.10/4 rr=3 / 64 trades; gold needs swing_anchor",
  },
  {
    name: "Library: USD/JPY sweep_reclaim-DailyBias-Long 4h",
    ticker: "USD/JPY",
    asset_class: "forex",
    entry_conditions: [
      patternCond("liquidity_sweep_reclaim", { lookback: 5 }),
      patternCond("daily_bias", { ma_period: 20 }),
    ],
    stop_loss: { type: "percentage", value: 0.5 },
    rr: 3,
    expected_6yr_dollars: 14605,
    source: "PR #262 sweep_reclaim — pct-0.50 rr=3 / 58 trades / DD 4.62% (DD-safe variant)",
  },
];

function buildRules(t: DeployTarget): Record<string, unknown> {
  return {
    side: "long",
    leverage: 9,
    prop_firm: PROP_FIRM,
    stop_loss: t.stop_loss,
    timeframe: "4h",
    asset_class: t.asset_class,
    take_profit: { type: "rr_multiple", value: t.rr },
    max_positions: 1,
    stagnant_exit: { enabled: true },
    exit_conditions: [],
    position_sizing: { type: "risk_per_trade", value: 0.6 },
    entry_conditions: t.entry_conditions,
    entry_logic: "all",
  };
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env.local");
  }
  const supabase = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  console.log(`Mode: ${APPLY ? "APPLY (will INSERT)" : "DRY RUN (no writes)"}\n`);
  console.log(`Targets: ${TARGETS.length} (expected aggregate ~$${TARGETS.reduce((s, t) => s + t.expected_6yr_dollars, 0).toLocaleString()} / 6yr)\n`);

  const { data: pattern, error: patternErr } = await supabase
    .from("algorithms")
    .select("user_id")
    .like("name", "Library: %")
    .eq("status", "active")
    .limit(1)
    .maybeSingle();
  if (patternErr || !pattern) {
    throw new Error(`Could not resolve operator user_id: ${patternErr?.message ?? "no matching row"}`);
  }
  const userId = pattern.user_id as string;
  console.log(`Resolved operator user_id: ${userId}\n`);

  let inserted = 0;
  let skipped = 0;
  for (const t of TARGETS) {
    console.log(`--- ${t.name} (${t.ticker}) ---`);
    console.log(`  source: ${t.source}`);
    console.log(`  expected 6yr: $${t.expected_6yr_dollars.toLocaleString()}`);

    const { data: existing, error: existingErr } = await supabase
      .from("algorithms")
      .select("id, status")
      .eq("user_id", userId)
      .eq("name", t.name)
      .maybeSingle();
    if (existingErr) {
      console.error(`  ✗ existence check failed: ${existingErr.message}\n`);
      continue;
    }
    if (existing) {
      console.log(`  ✓ ALREADY EXISTS (id=${existing.id.slice(0, 8)}…, status=${existing.status}). Skipping.\n`);
      skipped += 1;
      continue;
    }

    if (!APPLY) {
      console.log(`  (dry run — would insert)\n`);
      continue;
    }

    const { data: ins, error: insErr } = await supabase
      .from("algorithms")
      .insert({
        user_id: userId,
        name: t.name,
        description: `Multi-instrument paper deploy. ${t.source}. PAPER-ONLY pending ≥15d + ≥5 paper trades within ±50% R per feedback_live_mirror_milestone.`,
        status: "active",
        live_trading_enabled: false,
        broker_connection_id: null,
        rules: buildRules(t),
      })
      .select("id")
      .single();
    if (insErr || !ins) {
      console.error(`  ✗ insert failed: ${insErr?.message ?? "no row returned"}\n`);
      continue;
    }
    console.log(`  ✓ inserted id=${ins.id}`);

    const { error: wlErr } = await supabase.from("algorithm_watchlist").insert({
      user_id: userId,
      algorithm_id: ins.id,
      ticker: t.ticker,
      added_by: "user",
    });
    if (wlErr) {
      console.error(`  ⚠️  watchlist insert failed: ${wlErr.message}\n`);
      continue;
    }
    console.log(`  ✓ watchlist seeded with ${t.ticker}\n`);
    inserted += 1;
  }

  console.log(`\n=== Summary ===`);
  console.log(`  Inserted: ${inserted}`);
  console.log(`  Skipped (already exist): ${skipped}`);
  if (!APPLY) console.log(`\nDry run complete. Re-run with APPLY=1 to commit.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
