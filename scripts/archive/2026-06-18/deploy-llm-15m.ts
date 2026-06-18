/**
 * One-shot deploy: creates the Gold LLM-15m algorithm in DB.
 * 15m short-term scalper-positional hybrid using v5_15m prompt + structural
 * SL/TP (swing_anchor + rr_multiple). Pairs with the existing v1 4h and
 * Intraday 30m on the same broker (cross-algo risk-pool halt enforces
 * combined exposure cap).
 *
 * Validated config (2026-05-07 4-window WF, 84 trades over 4 × 30d windows
 * spanning chop / transition / drawdown / established trend regimes):
 *   Window A (chop):       36 trades · 47% WR · +20.61% · 0.65% DD
 *   Window B (transition): 17 trades · 65% WR · +9.46%  · 0.67% DD
 *   Window C (drawdown):   17 trades · 47% WR · +0.30%  · 0.52% DD
 *   Window D (trend):      14 trades · 36% WR · +8.78%  · 1.71% DD
 *   Total: +39.15% / max DD 1.71% — both validation gates passed.
 *
 *   - Prompt: v5_15m (multi-TF override on 30m + 1h, vs v5's 1h + 4h on
 *     30m primary). D1 lags heavily on 15m; override fires often.
 *   - Stop loss: swing_anchor lookback=12, ATR buffer 0.25 (~3h structure
 *     window — wider than 30m's 8-bar lookback to give 15m positions room
 *     to develop)
 *   - Take profit: rr_multiple 3 (3:1 RR — matches 30m Intraday)
 *   - Risk per trade: 0.75% (matches the rest of the live stack post
 *     2026-05-07 risk bump)
 *   - Max concurrent: 1 (matches scaling plan: 3 algos × 1 pos = 3 max
 *     concurrent positions per account)
 *   - Stagnant exit: 32 bars (~8h on 15m — between v1 4h's 48-bar/8-day
 *     and 30m Intraday's 24-bar/12h, scaled to 15m cadence)
 *
 * Known iteration target from WF: LH-aligned shorts went 0/4 across
 * windows where they were the regime-correct trade. SL placement (12-bar
 * swing_anchor) is too tight for 15m drawdown shorts — same SL distance
 * gives less ATR-headroom on 15m than 30m. Future v6_15m or asymmetric-
 * SL variant could widen `lookback=18` for shorts only.
 *
 * Multi-account-friendly: BROKER_CONNECTION_ID + ALGO_NAME + CAPITAL +
 * RISK_PER_TRADE + MAX_POSITIONS are all env-overridable so the same
 * script deploys to 1 × $50K demo today and 8 × $50K real accounts at
 * the scaling-plan endpoint.
 *
 * Defensive design (matches deploy-llm-intraday.ts):
 * - Idempotent: re-running after the algorithm already exists is a no-op
 * - DRY RUN by default: prints the row that WOULD be inserted; APPLY=1
 *   actually inserts
 * - Drops back to "operator activates" — never sets live_trading_enabled
 *   automatically. Deploy creates a paused row; activation is separate.
 *
 * Usage:
 *   pnpm dlx tsx scripts/deploy-llm-15m.ts          # dry run
 *   APPLY=1 pnpm dlx tsx scripts/deploy-llm-15m.ts  # apply
 *
 * Env (optional):
 *   BROKER_CONNECTION_ID  override (default: $50K v5 demo broker)
 *   ALGO_NAME             override (default: "Gold LLM-15m v1")
 *   CAPITAL               override (default: 50000)
 *   RISK_PER_TRADE        override (default: 0.75 — % per trade)
 *   MAX_POSITIONS         override (default: 1)
 *   PROMPT_VERSION        override (default: "v5_15m")
 *   DRY_RUN_LLM           "false" disables LLM dry-run mode at deploy
 *                         time (default: enabled — recommended for first
 *                         cycles)
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

// $50K v5 demo broker created 2026-05-07 — shared with v1 4h and Intraday 30m.
// Per-account $50K real-challenge deploys override via BROKER_CONNECTION_ID.
const DEFAULT_BROKER_CONNECTION_ID = "d31ac28f-a4a9-43a0-92f5-d53958bf5a4a";
const DEFAULT_ALGO_NAME = "Gold LLM-15m v1";
const DEFAULT_CAPITAL = 50_000;
const DEFAULT_RISK_PER_TRADE = 0.75;
const DEFAULT_MAX_POSITIONS = 1;
const DEFAULT_PROMPT_VERSION = "v5_15m" as const;
const TICKER = "XAU/USD";

type SupportedPromptVersion = "v1" | "v2" | "v3" | "v4" | "v5" | "v5_15m";

function buildRules(opts: {
  riskPerTrade: number;
  maxPositions: number;
  promptVersion: SupportedPromptVersion;
}): AlgorithmRules {
  return {
    asset_class: "commodity",
    side: "long", // ignored by LLM-trader path; LLM determines side
    timeframe: "15m",
    leverage: 9, // FTMO Swing gold leverage 1:9
    position_sizing: { type: "risk_per_trade", value: opts.riskPerTrade },
    // Structural SL/TP — validated 2026-05-07 4-window WF.
    // swing_anchor SL anchors to recent swing low/high (12-bar lookback ≈
    // 3h of 15m structure) plus 0.25 ATR buffer. Wider than 30m's 8-bar
    // because 15m needs more bars to capture meaningful structure.
    // rr_multiple TP = 3× SL distance.
    stop_loss: { type: "swing_anchor", value: 0.25, lookback: 12 },
    take_profit: { type: "rr_multiple", value: 3 },
    max_positions: opts.maxPositions,
    max_per_ticker: 1,
    entry_conditions: [], // empty — LLM determines entries
    exit_conditions: [],
    entry_logic: "all",
    // Prop-firm guardrails. consistency_rule set to 40 here to satisfy
    // the validator (min 10); operator MUST run the SQL update post-
    // deploy to set it to 0 (FTMO 2-step / Swing has no consistency rule).
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
    // Stagnant exit calibrated for 15m cadence. 32 bars ≈ 8h — between
    // v1 4h's 48-bar / 8-day and Intraday 30m's 24-bar / 12h. Scaled to
    // match the typical 15m setup-resolution window from the WF (most
    // trades resolve in 14-25 bars; stagnant cuts at 32 catch deeply-
    // stuck losers without trimming legitimate runners).
    stagnant_exit: {
      enabled: true,
      max_bars: 32,
      min_pnl_r: -0.3,
      min_excursion_r: 0.1,
    },
    // LLM-trader config. v5_15m prompt validated 2026-05-07 (4-window WF:
    // 84 trades / 48% WR / +39.15% / 1.71% max DD). dry_run=true means
    // the engine logs LLM decisions to activity_log but does NOT open
    // positions — recommended for first 1-2 cycles.
    llm_trader: {
      enabled: true,
      provider: "anthropic",
      prompt_version: opts.promptVersion,
      dry_run: process.env.DRY_RUN_LLM !== "false",
    },
    // dxy_filter / regime_filter / adx_filter intentionally OFF — the
    // LLM already considers DXY / regime / trend in its prompt context.
  };
}

async function main(): Promise<void> {
  const apply = process.env.APPLY === "1" || process.env.APPLY === "true";
  const brokerConnectionId = process.env.BROKER_CONNECTION_ID ?? DEFAULT_BROKER_CONNECTION_ID;
  const algoName = process.env.ALGO_NAME ?? DEFAULT_ALGO_NAME;
  const capital = Number(process.env.CAPITAL ?? DEFAULT_CAPITAL);
  const riskPerTrade = Number(process.env.RISK_PER_TRADE ?? DEFAULT_RISK_PER_TRADE);
  const maxPositions = Number(process.env.MAX_POSITIONS ?? DEFAULT_MAX_POSITIONS);
  const promptVersionRaw = (process.env.PROMPT_VERSION ?? DEFAULT_PROMPT_VERSION).toLowerCase();
  if (
    promptVersionRaw !== "v1" &&
    promptVersionRaw !== "v2" &&
    promptVersionRaw !== "v3" &&
    promptVersionRaw !== "v4" &&
    promptVersionRaw !== "v5" &&
    promptVersionRaw !== "v5_15m"
  ) {
    throw new Error(
      `Unsupported PROMPT_VERSION=${promptVersionRaw}. Use v1, v2, v3, v4, v5, or v5_15m.`
    );
  }
  const promptVersion = promptVersionRaw as SupportedPromptVersion;

  // Sanity bounds.
  if (riskPerTrade <= 0 || riskPerTrade > 5) {
    throw new Error(`RISK_PER_TRADE=${riskPerTrade} out of range (0, 5]`);
  }
  if (maxPositions < 1 || maxPositions > 10) {
    throw new Error(`MAX_POSITIONS=${maxPositions} out of range [1, 10]`);
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
  }
  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

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
  console.log(`  timeframe         : 15m`);
  console.log(`  prompt version    : ${promptVersion}`);
  console.log(`  risk per trade    : ${riskPerTrade}%`);
  console.log(`  max positions     : ${maxPositions}`);
  console.log(`  SL                : swing_anchor lookback=12 buf=0.25 ATR`);
  console.log(`  TP                : rr_multiple 3 (3:1 RR)`);
  console.log(`  stagnant exit     : 32 bars (~8h on 15m)`);
  console.log(`  dry_run (LLM)     : ${process.env.DRY_RUN_LLM !== "false"}`);
  console.log("");

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

  const rules = buildRules({ riskPerTrade, maxPositions, promptVersion });
  console.log(`Rules to insert:`);
  console.log(JSON.stringify(rules, null, 2));
  console.log("");

  if (!apply) {
    console.log("DRY RUN — no row inserted. Re-run with APPLY=1 to deploy.");
    return;
  }

  const { data: inserted, error: insertErr } = await supabase
    .from("algorithms")
    .insert({
      user_id: userId,
      name: algoName,
      description:
        "15m short-term AI trader (Anthropic Haiku 4.5). Discretionary direction calls + multi-TF override (D1+30m+1h) + structural SL (swing_anchor 12-bar lookback, 0.25 ATR buffer) + rr_multiple 3 TP. Validated 2026-05-07: 84 trades over 4 × 30d WF windows, 48% WR, +39.15%, max DD 1.71%, both validation gates passed. v5_15m prompt. Starts in dry-run mode.",
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
  console.log(`  1. SQL update for FTMO 2-step / Swing consistency rule:`);
  console.log(
    `     UPDATE algorithms SET rules = jsonb_set(rules, '{prop_firm,consistency_rule}', '0'::jsonb) WHERE id = '${algoId}';`
  );
  console.log(`  2. Open the algorithm at /algorithms/${algoId} to review the rules in the UI`);
  console.log(`  3. Activate when ready: status=active, live_trading_enabled=true (or via UI button)`);
  console.log(`  4. Watch activity_log for events with details->>'source'='llm_trader' over the next 1-2 15m cycles`);
  console.log(`  5. After confirming sensible LLM behaviour, flip rules.llm_trader.dry_run to false`);
  console.log("");
  console.log("Note: this algo runs on the SAME broker as v1 (4h) and Intraday (30m).");
  console.log("Risk-pool halt enforces combined exposure cap (default 3%) — at 0.75%");
  console.log("risk × 3 algos × 1 pos each = 2.25% combined max, well under the cap.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
