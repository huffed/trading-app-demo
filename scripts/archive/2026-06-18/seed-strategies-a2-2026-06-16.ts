/**
 * A2 of the strategy-umbrella rollout: seed one strategy row per
 * family and link existing 15 deployed library algos to their strategy.
 *
 * Schema added by migration 00042. This script:
 *   1. Creates one strategy row per family
 *   2. Sets algorithms.strategy_id on each library algo
 *
 * Strategy mapping (algorithm NAME pattern → strategy family):
 *
 *   "Library: Gold FVG-DailyBias-Long 4h"               → FVG-DailyBias
 *   "Library: EUR/USD FVG-DailyBias-Long 4h"            → FVG-DailyBias
 *   "Library: GBP/USD FVG-DailyBias-Long 4h"            → FVG-DailyBias
 *   "Library: USD/JPY FVG-DailyBias-Long 4h"            → FVG-DailyBias
 *
 *   "Library: Gold Dip-Buyer 4h"                        → Dip-Buyer
 *   "Library: EUR/USD Dip-Buyer-Long 4h"                → Dip-Buyer
 *   "Library: GBP/USD Dip-Buyer-Long 4h"                → Dip-Buyer
 *   "Library: USD/JPY Dip-Buyer-Long 4h"                → Dip-Buyer
 *
 *   "Library: Gold Coil-Breakout 1h"                    → Coil-Breakout
 *   "Library: Gold Coil-Breakout 4h"                    → Coil-Breakout
 *   "Library: USD/JPY Coil-Breakout-Long 4h"            → Coil-Breakout
 *
 *   "Library: Gold sweep_reclaim-DailyBias-Long 4h"     → sweep_reclaim-DailyBias
 *   "Library: USD/JPY sweep_reclaim-DailyBias-Long 4h"  → sweep_reclaim-DailyBias
 *
 *   "Library: Gold OTE-Long 4h"                         → OTE-Long
 *   "Library: Gold FVG-Long 30m"                        → FVG-Long
 *   "Library: Gold Bear-Short Sentinel 4h"              → Bear-Short Sentinel
 *
 * rules_template per strategy: contains the SHARED parts of the rules
 * (entry_conditions structure, entry_logic, take_profit when uniform,
 * prop_firm envelope, stagnant_exit, position_sizing, side, leverage,
 * timeframe). Per-instance algorithms.rules stays authoritative for
 * now (A3, deferred) — this seed populates the template field for
 * future use but doesn't change reads anywhere.
 *
 * Safety:
 *   - DRY RUN by default. APPLY=1 to commit.
 *   - Idempotent: skips strategy inserts where name exists; skips
 *     algorithm links where strategy_id already set.
 *
 * Usage:
 *   pnpm dlx tsx scripts/seed-strategies-a2-2026-06-16.ts        # dry run
 *   APPLY=1 pnpm dlx tsx scripts/seed-strategies-a2-2026-06-16.ts
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

interface StrategyDef {
  name: string;
  description: string;
  rules_template: Record<string, unknown>;
  /** Substrings matched against algorithm name. First match wins. */
  algorithm_name_matchers: string[];
}

const PROP_FIRM_TEMPLATE = {
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

const STRATEGIES: StrategyDef[] = [
  {
    name: "FVG-DailyBias",
    description:
      "Fair Value Gap entry confirmed by D1 SMA20 bullish bias. Deployed across XAU+EUR+GBP+JPY. Universal forex winner per PR #261; gold validated per PR #258.",
    rules_template: {
      side: "long",
      leverage: 9,
      timeframe: "4h",
      prop_firm: PROP_FIRM_TEMPLATE,
      take_profit: { type: "rr_multiple", value: 2 },
      max_positions: 1,
      stagnant_exit: { enabled: true },
      exit_conditions: [],
      position_sizing: { type: "risk_per_trade", value: 0.6 },
      entry_conditions: [
        { type: "pattern", pattern: "fvg", direction: "bullish", timeframe: "4h" },
        { type: "pattern", pattern: "daily_bias", direction: "bullish", ma_period: 20, timeframe: "4h" },
      ],
      entry_logic: "all",
    },
    algorithm_name_matchers: ["FVG-DailyBias-Long"],
  },
  {
    name: "Dip-Buyer",
    description:
      "Bullish liquidity sweep confirmed by D1 SMA20 bullish bias. Sweep entries can run longer than FVG → RR varies pair-by-pair (gold rr=3, JPY/GBP rr=5, EUR rr=3).",
    rules_template: {
      side: "long",
      leverage: 9,
      timeframe: "4h",
      prop_firm: PROP_FIRM_TEMPLATE,
      // take_profit not in template — varies by pair (3 or 5)
      max_positions: 1,
      stagnant_exit: { enabled: true },
      exit_conditions: [],
      position_sizing: { type: "risk_per_trade", value: 0.6 },
      entry_conditions: [
        { type: "pattern", pattern: "liquidity_sweep", direction: "bullish", lookback: 5, timeframe: "4h" },
        { type: "pattern", pattern: "daily_bias", direction: "bullish", ma_period: 20, timeframe: "4h" },
      ],
      entry_logic: "all",
    },
    algorithm_name_matchers: ["Dip-Buyer"],
  },
  {
    name: "Coil-Breakout",
    description:
      "Bullish BOS confirmed by D1 SMA20 bullish bias. Gold 1h LIVE since 2026; gold 4h paper; USD/JPY paper (JPY-specific edge — fails EUR/GBP per PR #261).",
    rules_template: {
      side: "long",
      leverage: 9,
      prop_firm: PROP_FIRM_TEMPLATE,
      take_profit: { type: "rr_multiple", value: 2 },
      max_positions: 1,
      stagnant_exit: { enabled: true },
      exit_conditions: [],
      position_sizing: { type: "risk_per_trade", value: 0.6 },
      entry_conditions: [
        { type: "pattern", pattern: "bos", direction: "bullish", lookback: 5 },
        { type: "pattern", pattern: "daily_bias", direction: "bullish", ma_period: 20 },
      ],
      entry_logic: "all",
      // timeframe varies (1h or 4h) — per-instance
    },
    algorithm_name_matchers: ["Coil-Breakout"],
  },
  {
    name: "sweep_reclaim-DailyBias",
    description:
      "Liquidity sweep + reclaim primitive (PR #262) + D1 SMA20 bullish bias. Smaller magnitude than FVG-DailyBias but real edge; deployed on gold + USD/JPY.",
    rules_template: {
      side: "long",
      leverage: 9,
      timeframe: "4h",
      prop_firm: PROP_FIRM_TEMPLATE,
      take_profit: { type: "rr_multiple", value: 3 },
      max_positions: 1,
      stagnant_exit: { enabled: true },
      exit_conditions: [],
      position_sizing: { type: "risk_per_trade", value: 0.6 },
      entry_conditions: [
        { type: "pattern", pattern: "liquidity_sweep_reclaim", direction: "bullish", lookback: 5, timeframe: "4h" },
        { type: "pattern", pattern: "daily_bias", direction: "bullish", ma_period: 20, timeframe: "4h" },
      ],
      entry_logic: "all",
    },
    algorithm_name_matchers: ["sweep_reclaim-DailyBias"],
  },
  {
    name: "OTE-Long",
    description:
      "Optimal Trade Entry (62-79% fib retracement). Gold-specific (forex tests negative per PR #263). Carries G3 regime gate (block usd_down OR fast_div_bull) for DD safety.",
    rules_template: {
      side: "long",
      leverage: 9,
      timeframe: "4h",
      asset_class: "commodity",
      prop_firm: PROP_FIRM_TEMPLATE,
      stop_loss: { type: "swing_anchor", value: 0.1, lookback: 4 },
      take_profit: { type: "rr_multiple", value: 3 },
      max_positions: 1,
      stagnant_exit: { enabled: true },
      exit_conditions: [],
      position_sizing: { type: "risk_per_trade", value: 0.6 },
      entry_conditions: [
        { type: "pattern", pattern: "ote", direction: "bullish", timeframe: "4h" },
      ],
      market_state_gate: {
        mode: "block",
        states: { dxy: ["usd_down"], mtf: ["fast_div_bull"] },
        on_unreadable: "allow",
      },
    },
    algorithm_name_matchers: ["OTE-Long"],
  },
  {
    name: "FVG-Long",
    description:
      "Pure Fair Value Gap entry (no daily_bias confirmation). Deployed only on gold 30m. Single-primitive variant; the FVG+bias confluence is FVG-DailyBias strategy.",
    rules_template: {
      side: "long",
      leverage: 9,
      timeframe: "30m",
      asset_class: "commodity",
      prop_firm: PROP_FIRM_TEMPLATE,
      stop_loss: { type: "swing_anchor", value: 0.1, lookback: 3 },
      take_profit: { type: "rr_multiple", value: 3 },
      max_positions: 1,
      stagnant_exit: { enabled: true },
      exit_conditions: [],
      position_sizing: { type: "risk_per_trade", value: 0.6 },
      entry_conditions: [
        { type: "pattern", pattern: "fvg", direction: "bullish", timeframe: "30m" },
      ],
    },
    algorithm_name_matchers: ["FVG-Long 30m"],
  },
  {
    name: "Bear-Short Sentinel",
    description:
      "Bearish BOS + D1 SMA20 bearish bias short on gold. Currently paused (no qualifying signals on 6yr corpus); preserved for future S5 forex deployment.",
    rules_template: {
      side: "short",
      leverage: 9,
      timeframe: "4h",
      asset_class: "commodity",
      prop_firm: PROP_FIRM_TEMPLATE,
      stop_loss: { type: "swing_anchor", value: 0.1, lookback: 4 },
      take_profit: { type: "rr_multiple", value: 3 },
      max_positions: 1,
      stagnant_exit: { enabled: true },
      exit_conditions: [],
      position_sizing: { type: "risk_per_trade", value: 0.6 },
      entry_conditions: [
        { type: "pattern", pattern: "bos", direction: "bearish", lookback: 5, timeframe: "4h" },
        { type: "pattern", pattern: "daily_bias", direction: "bearish", ma_period: 20, timeframe: "4h" },
      ],
      entry_logic: "all",
      market_state_gate: {
        mode: "allow",
        states: { mtf: ["aligned_LH"] },
        on_unreadable: "block",
      },
    },
    algorithm_name_matchers: ["Bear-Short Sentinel"],
  },
];

function matchStrategy(algoName: string): string | null {
  for (const s of STRATEGIES) {
    for (const m of s.algorithm_name_matchers) {
      if (algoName.includes(m)) return s.name;
    }
  }
  return null;
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
  }
  const supabase = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  console.log(`Mode: ${APPLY ? "APPLY (will INSERT/UPDATE)" : "DRY RUN (no writes)"}\n`);

  // Resolve operator user_id from an existing library algo.
  const { data: anyAlgo, error: anyErr } = await supabase
    .from("algorithms")
    .select("user_id")
    .like("name", "Library: %")
    .eq("status", "active")
    .limit(1)
    .maybeSingle();
  if (anyErr || !anyAlgo) {
    throw new Error(`Cannot resolve user_id: ${anyErr?.message ?? "no library algo found"}`);
  }
  const userId = anyAlgo.user_id as string;
  console.log(`Resolved operator user_id: ${userId}\n`);

  // 1. Seed strategies.
  console.log("--- Strategy seed ---");
  const strategyIdByName = new Map<string, string>();
  for (const s of STRATEGIES) {
    const { data: existing, error: exErr } = await supabase
      .from("strategies")
      .select("id")
      .eq("user_id", userId)
      .eq("name", s.name)
      .maybeSingle();
    if (exErr) {
      console.error(`  ✗ ${s.name}: existence check failed: ${exErr.message}`);
      continue;
    }
    if (existing) {
      console.log(`  ✓ ${s.name}: already exists (id=${existing.id.slice(0, 8)}…)`);
      strategyIdByName.set(s.name, existing.id);
      continue;
    }
    if (!APPLY) {
      console.log(`  (dry run — would insert) ${s.name}`);
      continue;
    }
    const { data: ins, error: insErr } = await supabase
      .from("strategies")
      .insert({
        user_id: userId,
        name: s.name,
        description: s.description,
        rules_template: s.rules_template,
        status: "active",
      })
      .select("id")
      .single();
    if (insErr || !ins) {
      console.error(`  ✗ ${s.name}: insert failed: ${insErr?.message ?? "no row returned"}`);
      continue;
    }
    console.log(`  ✓ ${s.name}: inserted id=${ins.id.slice(0, 8)}…`);
    strategyIdByName.set(s.name, ins.id);
  }

  // 2. Link existing library algos.
  console.log("\n--- Algorithm linking ---");
  const { data: algos, error: algosErr } = await supabase
    .from("algorithms")
    .select("id, name, strategy_id")
    .like("name", "Library: %");
  if (algosErr || !algos) {
    throw new Error(`Cannot fetch algorithms: ${algosErr?.message ?? "no rows"}`);
  }

  let linked = 0;
  let alreadyLinked = 0;
  let unmatched = 0;
  for (const a of algos) {
    const stratName = matchStrategy(a.name);
    if (!stratName) {
      console.error(`  ✗ ${a.name}: no matching strategy`);
      unmatched += 1;
      continue;
    }
    const stratId = strategyIdByName.get(stratName);
    if (!stratId) {
      console.error(`  ✗ ${a.name}: matched "${stratName}" but no id (strategy seed must run first)`);
      continue;
    }
    if (a.strategy_id === stratId) {
      console.log(`  ✓ ${a.name}: already linked to ${stratName}`);
      alreadyLinked += 1;
      continue;
    }
    if (a.strategy_id) {
      console.log(
        `  ⚠️  ${a.name}: currently linked to a different strategy_id=${(a.strategy_id as string).slice(0, 8)}… (would overwrite to ${stratName})`
      );
    } else {
      console.log(`  → ${a.name}: link to ${stratName}`);
    }
    if (!APPLY) continue;
    const { error: updErr } = await supabase
      .from("algorithms")
      .update({ strategy_id: stratId })
      .eq("id", a.id);
    if (updErr) {
      console.error(`    ✗ link update failed: ${updErr.message}`);
      continue;
    }
    linked += 1;
  }

  console.log(`\n=== Summary ===`);
  console.log(`  Strategies: ${strategyIdByName.size}`);
  console.log(`  Algorithms linked this run: ${linked}`);
  console.log(`  Already linked: ${alreadyLinked}`);
  console.log(`  Unmatched: ${unmatched}`);
  if (!APPLY) console.log(`\nDry run complete. Re-run with APPLY=1 to commit.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
