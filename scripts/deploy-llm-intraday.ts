/**
 * One-shot deploy: creates the Gold LLM-Intraday v1 algorithm in DB.
 * 30m short-term swing variant of the LLM-trader, using structural
 * SL/TP (swing_anchor + rr_multiple) instead of fixed-%.
 *
 * Validated config (2026-05-02 backtest, +7.20% / 1.60% DD over 30 cal
 * days on XAU/USD 30m):
 *   - Prompt: v3 (scalper variant — works as short-term swing too)
 *   - Stop loss: swing_anchor lookback=8, ATR buffer 0.25
 *   - Take profit: rr_multiple 3 (3:1 RR)
 *   - Risk per trade: 1.0% (operator's plan for $100K demo)
 *   - Max concurrent: 2 (conservative until risk-pooling #28 ships;
 *     scaling plan target is 3 once cross-algo pooling exists)
 *   - Tighter stagnant exit (12h on 30m vs v1's 8d on 4h)
 *
 * Note on v4 + LLM-judged BE: the v4 prompt + move_be infrastructure
 * exists but is NOT used here. The 2026-05-02 v4 backtest produced
 * +3.19% / 3.57% DD — clearly worse than baseline. v4 + BE iteration
 * will retry as v5 with stricter BE criteria + trail-stop levels (#34).
 *
 * Multi-account-friendly: BROKER_CONNECTION_ID + ALGO_NAME + CAPITAL
 * + RISK_PER_TRADE + MAX_POSITIONS are all env-overridable so the
 * same script deploys to 1 × $100K demo today and 8 × $50K accounts
 * at the scaling-plan endpoint.
 *
 * Defensive design (matches deploy-llm-trader.ts):
 * - Idempotent: re-running after the algorithm already exists is a
 *   no-op (logs "already deployed").
 * - DRY RUN by default: prints the row that WOULD be inserted but
 *   doesn't write. APPLY=1 actually inserts.
 * - Drops back to "operator activates" — never sets live_trading_enabled
 *   automatically. The deploy creates a paused row; activation is a
 *   separate explicit action.
 *
 * Usage:
 *   pnpm dlx tsx scripts/deploy-llm-intraday.ts          # dry run
 *   APPLY=1 pnpm dlx tsx scripts/deploy-llm-intraday.ts  # apply
 *
 * Env (optional):
 *   BROKER_CONNECTION_ID  override (default: same FTMO MetaApi as v1)
 *   ALGO_NAME             override (default: "Gold LLM-Intraday v1")
 *   CAPITAL               override (default: 100000)
 *   RISK_PER_TRADE        override (default: 1.0 — % per trade)
 *   MAX_POSITIONS         override (default: 2 — concurrent positions)
 *   PROMPT_VERSION        override (default: "v3" — validated 30m config)
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

const DEFAULT_BROKER_CONNECTION_ID = "1bc8dd11-49b6-49ed-861b-d5760a9ae90d";
const DEFAULT_ALGO_NAME = "Gold LLM-Intraday v1";
const DEFAULT_CAPITAL = 100_000;
const DEFAULT_RISK_PER_TRADE = 1.0;
const DEFAULT_MAX_POSITIONS = 2;
const DEFAULT_PROMPT_VERSION = "v3" as const;
const TICKER = "XAU/USD";

function buildRules(opts: {
  riskPerTrade: number;
  maxPositions: number;
  promptVersion: "v1" | "v2" | "v3" | "v4";
}): AlgorithmRules {
  return {
    asset_class: "commodity",
    side: "long", // ignored by LLM-trader path; LLM determines side
    timeframe: "30m",
    leverage: 50,
    position_sizing: { type: "risk_per_trade", value: opts.riskPerTrade },
    // Structural SL/TP — validated 2026-05-02 backtest. swing_anchor SL
    // anchors to recent swing low/high (8-bar lookback) plus 0.25 ATR
    // buffer to escape immediate sweeps. rr_multiple TP = 3× SL distance.
    stop_loss: { type: "swing_anchor", value: 0.25, lookback: 8 },
    take_profit: { type: "rr_multiple", value: 3 },
    max_positions: opts.maxPositions,
    max_per_ticker: 1,
    entry_conditions: [], // empty — LLM determines entries
    exit_conditions: [],
    entry_logic: "all",
    // Prop-firm guardrails. consistency_rule set to 40 here to satisfy
    // the validator (min 10); operator MUST run the SQL update below
    // post-deploy to set it to 0 (2-step path has no consistency rule).
    // Matches v1 deploy pattern.
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
    // Tighter stagnant exit for 30m short-term swing. v1 uses 48 bars
    // (8 days on 4h); 30m needs ~24 bars (12h) so deeply-stuck losers
    // get cut faster. Aligned with project_scaling_plan + Task #33.
    stagnant_exit: {
      enabled: true,
      max_bars: 24,
      min_pnl_r: -0.3,
      min_excursion_r: 0.1,
    },
    // LLM-trader config. v3 prompt was validated for 30m (40-trade
    // 2026-05-02 evaluation: 25% WR / +6.92% with fixed-%, then 30%
    // WR / +7.20% with structural SL). dry_run=true means the engine
    // logs LLM decisions to activity_log but does NOT actually open
    // positions. Flip to false (in DB or via a follow-up script) once
    // the operator has watched a few cycles.
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
    promptVersionRaw !== "v4"
  ) {
    throw new Error(`Unsupported PROMPT_VERSION=${promptVersionRaw}. Use v1, v2, v3, or v4.`);
  }
  const promptVersion: "v1" | "v2" | "v3" | "v4" = promptVersionRaw;

  // Sanity bounds — match validator's risk_per_trade max (5%) and
  // catch obvious unit errors before insertion.
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
  console.log(`  timeframe         : 30m`);
  console.log(`  prompt version    : ${promptVersion}`);
  console.log(`  risk per trade    : ${riskPerTrade}%`);
  console.log(`  max positions     : ${maxPositions}`);
  console.log(`  SL                : swing_anchor lookback=8 buf=0.25 ATR`);
  console.log(`  TP                : rr_multiple 3 (3:1 RR)`);
  console.log(`  stagnant exit     : 24 bars (12h on 30m)`);
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
        "30m short-term swing AI trader (Anthropic Haiku 4.5). Discretionary direction calls + structural SL (swing_anchor 8-bar lookback, 0.25 ATR buffer) + rr_multiple 3 TP. Validated 2026-05-02: 30% WR, +7.20%, 1.60% DD on 40-trade XAU/USD 30m backtest. v3 prompt; v4 BE variant tested + rejected. Starts in dry-run mode.",
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
  console.log(`  1. SQL update for 2-step consistency rule (validator forces min 10 at deploy):`);
  console.log(
    `     UPDATE algorithms SET rules = jsonb_set(rules, '{prop_firm,consistency_rule}', '0'::jsonb) WHERE id = '${algoId}';`
  );
  console.log(`  2. Open the algorithm at /algorithms/${algoId} to review the rules in the UI`);
  console.log(`  3. Activate when ready: status=active, live_trading_enabled=true (or via UI button)`);
  console.log(`  4. Watch activity_log for events with details->>'source'='llm_trader' over the next 1-2 30m cycles`);
  console.log(`  5. After confirming sensible LLM behaviour, flip rules.llm_trader.dry_run to false`);
  console.log("");
  console.log("Note: this algo runs on the SAME broker as v1 (4h swing). Both algos");
  console.log("contribute to the same daily loss limit. Risk-pooling between algos");
  console.log("is task #28 — until shipped, monitor combined exposure manually.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
