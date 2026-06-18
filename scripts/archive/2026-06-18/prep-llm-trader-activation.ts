/**
 * Pre-activation prep for the LLM-trader algorithm. Performs the three
 * updates the operator wants in place before flipping the row to active:
 *
 *   1. Bumps `rules.position_sizing.value` from 1.0 → 1.5 (risk per trade).
 *      Reasoning: 65% WR / 0.75% peak DD across 3 backtest windows leaves
 *      headroom; 1.5% risk × ~3 trades/month at 65% WR + 1:3 RR ≈ ~10%/2-3mo
 *      target with backtest-implied drawdown still well inside FTMO 5% DLL.
 *      Direct quote from operator: "10% profit in 2-3 months even if
 *      drawdown goes up to around 8%".
 *
 *   2. Populates `backtest_results` with the validated stats from the
 *      three Anthropic Haiku 60d windows. The drift detector reads this
 *      column when comparing live WR/return to the baseline; without it,
 *      drift can't trigger.
 *
 *   3. Prints the resulting row for verification.
 *
 * Usage:
 *   pnpm dlx tsx scripts/prep-llm-trader-activation.ts          # dry run
 *   APPLY=1 pnpm dlx tsx scripts/prep-llm-trader-activation.ts  # apply
 *
 * Idempotent: re-running with APPLY=1 after the update has been applied
 * just re-writes the same values.
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

const ALGO_ID = "6b6b1907-c76d-4f1e-ad40-a8170183dd86";
const NEW_RISK_PCT = 1.5;

const VALIDATED_BACKTEST_RESULTS = {
  total_trades: 20,
  win_rate: 65,
  total_return: 20217,
  max_drawdown: 0.75,
  _source:
    "LLM-trader v1 — 3 historical 60d Anthropic Haiku backtests on XAU/USD 4h. Win rate aggregated across non-overlapping windows (Mar-Apr 2026, Dec 2025-Jan 2026, Oct-Nov 2025). max_drawdown is peak across all windows.",
  _validated_at: "2026-05-01",
  _prompt_version: "v1",
  _provider: "anthropic",
  _model: "claude-haiku-4-5-20251001",
};

async function main(): Promise<void> {
  const apply = process.env.APPLY === "1" || process.env.APPLY === "true";

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
  }
  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: existing, error: readErr } = await supabase
    .from("algorithms")
    .select("id, name, status, live_trading_enabled, capital, rules, backtest_results")
    .eq("id", ALGO_ID)
    .single();
  if (readErr || !existing) {
    throw new Error(`Algorithm ${ALGO_ID} not found: ${readErr?.message ?? ""}`);
  }
  const row = existing as {
    id: string;
    name: string;
    status: string;
    live_trading_enabled: boolean;
    capital: number;
    rules: Record<string, unknown>;
    backtest_results: Record<string, unknown> | null;
  };

  const currentRules = row.rules ?? {};
  const currentSizing = (currentRules.position_sizing ?? {}) as Record<string, unknown>;
  const currentRiskValue = currentSizing.value;

  console.log(`Current state of "${row.name}" (${row.id.slice(0, 8)}):`);
  console.log(`  status               : ${row.status}`);
  console.log(`  live_trading_enabled : ${row.live_trading_enabled}`);
  console.log(`  capital              : $${(row.capital ?? 0).toLocaleString()}`);
  console.log(`  position_sizing      : ${JSON.stringify(currentSizing)}`);
  console.log(`  backtest_results     : ${row.backtest_results ? "populated" : "NULL"}`);
  console.log("");
  console.log(`Planned changes:`);
  console.log(`  position_sizing.value : ${currentRiskValue} → ${NEW_RISK_PCT}`);
  console.log(`  backtest_results      : populate with validated stats (20t / 65% WR / +$20,217 / 0.75% DD)`);
  console.log("");

  if (!apply) {
    console.log("DRY RUN — no update performed. Re-run with APPLY=1 to apply.");
    return;
  }

  const newRules = {
    ...currentRules,
    position_sizing: {
      ...currentSizing,
      value: NEW_RISK_PCT,
    },
  };

  const { data: updated, error: updateErr } = await supabase
    .from("algorithms")
    .update({
      rules: newRules,
      backtest_results: VALIDATED_BACKTEST_RESULTS,
    })
    .eq("id", ALGO_ID)
    .select(
      "id, name, status, live_trading_enabled, capital, rules, backtest_results"
    )
    .single();
  if (updateErr || !updated) {
    throw new Error(`Update failed: ${updateErr?.message ?? "unknown"}`);
  }
  const after = updated as typeof row;
  const afterRules = (after.rules ?? {}) as Record<string, unknown>;
  const afterSizing = (afterRules.position_sizing ?? {}) as Record<string, unknown>;
  const afterLlm = (afterRules.llm_trader ?? {}) as Record<string, unknown>;

  console.log(`Update applied. Verified state:`);
  console.log(`  status               : ${after.status}`);
  console.log(`  live_trading_enabled : ${after.live_trading_enabled}`);
  console.log(`  position_sizing      : ${JSON.stringify(afterSizing)}`);
  console.log(`  llm_trader           : ${JSON.stringify(afterLlm)}`);
  console.log(`  backtest_results     : ${JSON.stringify(after.backtest_results, null, 2)}`);
  console.log("");
  console.log("Pre-activation prep complete. The algorithm remains paused with dry_run=true.");
  console.log("");
  console.log("Next steps:");
  console.log("  1. Run readiness check (operator endpoint):");
  console.log(
    `     curl -s -H "Authorization: Bearer $CRON_SECRET" "http://localhost:3000/api/admin/readiness-check?id=${ALGO_ID}" | jq`
  );
  console.log(
    "     Note: walk-forward portion will fail by design (LLM-trader has empty entry_conditions);"
  );
  console.log("     check the other gates (capital, watchlist, broker connection, news veto).");
  console.log("  2. Operator activates from dashboard or via:");
  console.log(
    `     UPDATE algorithms SET status='active', live_trading_enabled=true WHERE id='${ALGO_ID}';`
  );
  console.log(
    "  3. Watch activity_log for events with details->>'source'='llm_trader' over the next 1-2 4h cycles."
  );
  console.log(
    "  4. After confirming sensible LLM behaviour, flip rules.llm_trader.dry_run to false."
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
