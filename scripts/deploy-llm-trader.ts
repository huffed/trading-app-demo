/**
 * One-shot deploy: creates the LLM-trader algorithm in DB, configured
 * for gold (XAU/USD) on 4h with rules.llm_trader.enabled=true and
 * dry_run=true. The algorithm starts in `paused` status — operator
 * activates it manually after verifying the row in the dashboard.
 *
 * Defensive design (matches scripts/deploy-algo-d-dxy.ts idiom):
 * - Idempotent: re-running after the algorithm already exists is a
 *   no-op (logs "already deployed").
 * - DRY RUN by default: prints the row that WOULD be inserted but
 *   doesn't write. APPLY=1 actually inserts.
 * - Drops back to "operator activates" — never sets live_trading_enabled
 *   automatically. The deploy creates a paused row; activation is a
 *   separate explicit action.
 *
 * Prerequisite: branch `feat/llm-trader-mvp` (PR pending) merged to
 * dev — needs the `rules.llm_trader` schema field + scan engine
 * integration to be present, otherwise the validator will reject the
 * row OR the engine will silently skip the LLM path.
 *
 * Usage:
 *   pnpm dlx tsx scripts/deploy-llm-trader.ts          # dry run
 *   APPLY=1 pnpm dlx tsx scripts/deploy-llm-trader.ts  # apply
 *
 * Env (optional):
 *   BROKER_CONNECTION_ID  override (default: existing FTMO MetaApi conn)
 *   ALGO_NAME             override (default: "Gold LLM-Trader v1")
 *   CAPITAL               override (default: 100000)
 *   DRY_RUN_LLM           "false" disables LLM dry-run mode at deploy
 *                         time (default: enabled — recommended for
 *                         first cycles)
 */
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import type { AlgorithmRules } from "../src/types/algorithm";

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

// Current $100K FTMO Demo trial (broker `9a79809e-...`). Per-account
// $50K deploys override via BROKER_CONNECTION_ID env var per
// project_scaling_plan.
const DEFAULT_BROKER_CONNECTION_ID = "9a79809e-e6eb-44dd-b0a2-6bf18de3bb7a";
const DEFAULT_ALGO_NAME = "Gold LLM-Trader v1";
const DEFAULT_CAPITAL = 100_000;
const TICKER = "XAU/USD";

function buildRules(): AlgorithmRules {
  return {
    asset_class: "commodity",
    side: "long", // ignored by LLM-trader path; LLM determines side
    timeframe: "4h",
    leverage: 50,
    position_sizing: { type: "risk_per_trade", value: 1 },
    // SL/TP fixed to match the validated backtest baseline
    // (1.5%/4.5% = 3:1 RR). Structural SL/TP is a v2 concern.
    stop_loss: { type: "percentage", value: 1.5 },
    take_profit: { type: "percentage", value: 4.5 },
    max_positions: 1,
    max_per_ticker: 1,
    entry_conditions: [], // empty — LLM determines entries
    exit_conditions: [],
    entry_logic: "all",
    // Prop-firm guardrails (FTMO standard challenge defaults)
    prop_firm: {
      max_drawdown: 10,
      profit_target: 10,
      daily_loss_limit: 5,
      consistency_rule: 40,
      consecutive_loss_daily_halt: 3,
      consecutive_loss_unit: "days",
      max_consecutive_losses: 0,
      slippage_bps: 10,
      spread_bps: 5,
      commission_pct: 0,
    },
    news_veto: {
      enabled: true,
      min_impact: "high",
      block_minutes_before: 5,
      block_minutes_after: 15,
    },
    stagnant_exit: {
      enabled: true,
      max_bars: 48, // 8 days on 4h
      min_pnl_r: -0.5,
      min_excursion_r: 0.1,
    },
    // The new bit: LLM-trader config. dry_run=true means the engine
    // logs LLM decisions to activity_log but does NOT actually open
    // positions. Flip to false (in DB or via a follow-up script) once
    // the operator has watched a few cycles and is confident the LLM
    // is reasoning sensibly on real-time data.
    llm_trader: {
      enabled: true,
      provider: "anthropic",
      // v2 reframes the →RANGING regime-flip exit; validated 2026-05-01:
      // 5/6 windows green / +25.4% / 0.76% DD vs v1's +15.8% / 2.25% DD.
      prompt_version: "v2",
      dry_run: process.env.DRY_RUN_LLM !== "false",
    },
    // dxy_filter / regime_filter / adx_filter intentionally OFF — the
    // LLM already considers DXY / regime / trend in its prompt context;
    // gating on them again would double-count.
  };
}

async function main(): Promise<void> {
  const apply = process.env.APPLY === "1" || process.env.APPLY === "true";
  const brokerConnectionId = process.env.BROKER_CONNECTION_ID ?? DEFAULT_BROKER_CONNECTION_ID;
  const algoName = process.env.ALGO_NAME ?? DEFAULT_ALGO_NAME;
  const capital = Number(process.env.CAPITAL ?? DEFAULT_CAPITAL);

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
  }
  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Resolve the user_id from the broker connection.
  const { data: connRow, error: connErr } = await supabase
    .from("broker_connections")
    .select("id, user_id, provider, account_id")
    .eq("id", brokerConnectionId)
    .single();
  if (connErr || !connRow) {
    throw new Error(`broker_connection ${brokerConnectionId} not found: ${connErr?.message ?? ""}`);
  }
  const userId = (connRow as { user_id: string }).user_id;

  console.log(`Deploy plan:`);
  console.log(`  broker_connection : ${brokerConnectionId} (${(connRow as { provider: string }).provider})`);
  console.log(`  user_id           : ${userId}`);
  console.log(`  algo name         : ${algoName}`);
  console.log(`  capital           : $${capital.toLocaleString()}`);
  console.log(`  ticker            : ${TICKER}`);
  console.log("");

  // Idempotency: skip if an algorithm with this name already exists for this user.
  const { data: existingRow } = await supabase
    .from("algorithms")
    .select("id, name, status, live_trading_enabled, rules")
    .eq("user_id", userId)
    .eq("name", algoName)
    .maybeSingle();
  if (existingRow) {
    const existing = existingRow as {
      id: string;
      name: string;
      status: string;
      live_trading_enabled: boolean;
      rules: AlgorithmRules;
    };
    console.log(`Algorithm "${algoName}" already exists (id ${existing.id.slice(0, 8)}).`);
    console.log(
      `  status=${existing.status} · live_trading_enabled=${existing.live_trading_enabled} · llm_trader.enabled=${existing.rules.llm_trader?.enabled ?? false} · dry_run=${existing.rules.llm_trader?.dry_run ?? "n/a"}`
    );
    console.log("No-op. To replace, archive the existing row and re-run.");
    return;
  }

  const rules = buildRules();
  console.log(`Rules to insert:`);
  console.log(JSON.stringify(rules, null, 2));
  console.log("");

  if (!apply) {
    console.log("DRY RUN — no row inserted. Re-run with APPLY=1 to deploy.");
    return;
  }

  // Insert the algorithm row (paused — operator activates manually).
  const { data: inserted, error: insertErr } = await supabase
    .from("algorithms")
    .insert({
      user_id: userId,
      name: algoName,
      description:
        "Discretionary AI trader (Anthropic Haiku 4.5). Validated on 3 historical 60d windows: 65% WR, +20.2%, 0.75% peak DD. v1 prompt: structure-first bias hierarchy + regime-flip exits. Starts in dry-run mode.",
      asset_class: "commodity",
      capital,
      status: "paused",
      live_trading_enabled: false,
      broker_connection_id: brokerConnectionId,
      rules,
    })
    .select("id")
    .single();
  if (insertErr || !inserted) {
    throw new Error(`Algorithm insert failed: ${insertErr?.message ?? "unknown"}`);
  }
  const algoId = (inserted as { id: string }).id;
  console.log(`Algorithm row inserted: id ${algoId}`);

  // Add the watchlist entry for XAU/USD.
  const { error: wlErr } = await supabase.from("algorithm_watchlist").insert({
    algorithm_id: algoId,
    user_id: userId,
    ticker: TICKER,
    name: "Gold",
    added_by: "user",
  });
  if (wlErr) {
    throw new Error(`Watchlist insert failed: ${wlErr.message}`);
  }
  console.log(`Watchlist entry added: ${TICKER}`);
  console.log("");
  console.log("Deploy complete. The algorithm is PAUSED and dry_run is ON.");
  console.log("");
  console.log("Next steps for the operator:");
  console.log(
    `  1. Open the algorithm at /algorithms/${algoId} to review the rules in the UI`
  );
  console.log(
    `  2. Activate when ready: status=active, live_trading_enabled=true (or via UI button)`
  );
  console.log(
    `  3. Watch activity_log for events with details->>'source'='llm_trader' over the next 1-2 4h cycles`
  );
  console.log(
    `  4. After confirming sensible LLM behaviour, flip rules.llm_trader.dry_run to false (separate UPDATE)`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
