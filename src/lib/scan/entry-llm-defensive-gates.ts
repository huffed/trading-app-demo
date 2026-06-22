/**
 * Defensive pre-gates for the LLM-trader entry path. Six gates that fire
 * BEFORE the LLM call when the algo is FLAT (no open position). Extracted
 * from `entry-llm-trader.ts` in CB.H1 (2026-06-20) — the gate cluster was
 * a ~120-line `if (!currentPosition) { ... }` block in the middle of the
 * orchestrator; cohesion-extracting it shrinks the orchestrator and gives
 * a testable seam for the gate-cluster as a whole.
 *
 * Each gate:
 *  - Reads its own config off `rules` (most are optional / opt-in)
 *  - Returns `{ blocked: true }` after logging a `signal_no_action` if it fires
 *  - Returns `{ blocked: false }` to fall through to the next gate
 *
 * The 6 gates in order:
 *  1. Dead-hour gate (18-19 UTC London close — empirically 0/7 WR)
 *  2. ATR liquidity gate (compressed-vol skip; the caller already
 *     computed `liquidity` so it can ALSO log it on signal_detected later)
 *  3. News veto (Finnhub tier-1 events)
 *  4. Consecutive-loss halt (R-aware 0.25 threshold)
 *  5. Re-entry cooldown (refuse re-entry within 1 primary-TF bar of a loss)
 *  6. Consistency halt (FTMO 40% rule; broker-only)
 *
 * IMPORTANT: these only run when flat. When a position is open, the LLM
 * is always called so it can hold/exit/move_be. See 2026-05-11 incident
 * (4h XAU/USD $365 SL after ATR gate skipped 3 consecutive LLM calls).
 */
import type { checkAtrLiquidity } from "@/lib/algorithm/intraday-atr-gate";
import { checkReEntryCooldown } from "@/lib/algorithm/re-entry-cooldown";
import { parseBarDate } from "@/lib/market-data/parse-bar-date";
import { checkConsecutiveLossHalt } from "./consec-loss-halt";
import { checkConsistencyHalt } from "./consistency-halt";
import { checkNewsVeto } from "./entry-gates";
import { logActivity } from "./helpers";
import type { EntryContext } from "./entry";

export interface DefensiveLlmGatesResult {
  blocked: boolean;
}

export async function checkDefensiveLlmGates(
  ctx: EntryContext,
  liquidity: ReturnType<typeof checkAtrLiquidity>
): Promise<DefensiveLlmGatesResult> {
  const { supabase, userId, algo, ticker, bars, brokerCtx } = ctx;
  const rules = algo.rules;

  // Dead-hour gate — empirically blocks two specific UTC hours.
  //
  // Originally calibrated as "04-05 UTC Asia early-morning chop" against
  // backtests where Twelve Data returned XAU/USD bars in Sydney local
  // time (UTC+10) but the code parsed them as UTC. Sydney 04-05 is
  // actually 18-19 UTC the previous day — i.e. London close, not
  // Asia chop. The empirical evidence (0/7 WR across two 30d backtests
  // + a -1R live loss on 2026-05-05) was sound; just labeled wrong.
  //
  // Now that Twelve Data is fetched with `timezone=UTC`, bar timestamps
  // are honest UTC. The hour comparison shifts to 18, 19 to preserve
  // the same real-world hours that were validated.
  // parseBarDate so the host TZ doesn't skew the UTC hour read — see
  // parse-bar-date.ts for the 2026-05-12 incident.
  const utcHour = parseBarDate(bars[bars.length - 1].date).getUTCHours();
  if (utcHour === 18 || utcHour === 19) {
    await logActivity(supabase, userId, {
      algorithm_id: algo.id,
      event_type: "signal_no_action",
      ticker,
      details: {
        reason: `Dead-hour gate: ${utcHour}:00 UTC (London close) — 0/7 historic WR across two 30d backtests + first live loss; calibration was on Sydney-time bars (now corrected) so block hours are 18-19 UTC, originally labeled 04-05`,
        source: "llm_trader",
        utc_hour: utcHour,
      },
    });
    return { blocked: true };
  }

  if (liquidity.skip) {
    await logActivity(supabase, userId, {
      algorithm_id: algo.id,
      event_type: "signal_no_action",
      ticker,
      details: {
        reason: liquidity.reason ?? "ATR liquidity gate triggered",
        source: "llm_trader",
        atr_current: liquidity.atr_current,
        atr_threshold: liquidity.atr_threshold,
      },
    });
    return { blocked: true };
  }

  // News veto — defensive gate (mirror evaluateEntry). Same function
  // the deterministic path uses; imported statically from entry-gates.ts.
  const veto = await checkNewsVeto(rules, ticker);
  if (veto.vetoed) {
    await logActivity(supabase, userId, {
      algorithm_id: algo.id,
      event_type: "signal_no_action",
      ticker,
      details: { reason: `News veto: ${veto.reason}`, source: "llm_trader" },
    });
    return { blocked: true };
  }

  const consecHalt = rules.prop_firm?.consecutive_loss_daily_halt ?? 0;
  if (consecHalt > 0) {
    const halt = await checkConsecutiveLossHalt(supabase, algo.id, consecHalt);
    if (halt.tripped) {
      await logActivity(supabase, userId, {
        algorithm_id: algo.id,
        event_type: "signal_no_action",
        ticker,
        details: {
          reason: `Consecutive-loss halt: ${halt.streak}/${halt.threshold} losses today`,
          source: "llm_trader",
        },
      });
      return { blocked: true };
    }
  }

  if (await runCooldownAndConsistencyGates({ supabase, userId, algoId: algo.id, ticker, rules, brokerCtx })) {
    return { blocked: true };
  }

  return { blocked: false };
}

interface CooldownConsistencyArgs {
  supabase: EntryContext["supabase"];
  userId: string;
  algoId: string;
  ticker: string;
  rules: EntryContext["algo"]["rules"];
  brokerCtx: EntryContext["brokerCtx"];
}

/** Re-entry cooldown + FTMO consistency halt — the last 2 defensive
 *  gates. Returns true when either blocks the entry. Extracted from
 *  checkDefensiveLlmGates for CB.H2 fit. */
async function runCooldownAndConsistencyGates(a: CooldownConsistencyArgs): Promise<boolean> {
  const { supabase, userId, algoId, ticker, rules, brokerCtx } = a;
  const cooldown = await checkReEntryCooldown({
    supabase,
    algorithmId: algoId,
    ticker,
    timeframe: rules.timeframe,
  });
  if (cooldown.block) {
    await logActivity(supabase, userId, {
      algorithm_id: algoId,
      event_type: "signal_no_action",
      ticker,
      details: {
        reason: cooldown.reason ?? "Re-entry cooldown triggered",
        source: "llm_trader",
        cooldown_minutes: cooldown.cooldown_minutes,
        elapsed_minutes: cooldown.elapsed_minutes,
        last_close_id: cooldown.last_close_id,
        last_exit_reason: cooldown.last_exit_reason,
        last_realized_pnl: cooldown.last_realized_pnl,
      },
    });
    return true;
  }
  const consistencyPct = rules.prop_firm?.consistency_rule ?? 0;
  if (consistencyPct > 0 && brokerCtx) {
    const halt = await checkConsistencyHalt(supabase, algoId, consistencyPct);
    if (halt.tripped) {
      await logActivity(supabase, userId, {
        algorithm_id: algoId,
        event_type: "signal_no_action",
        ticker,
        details: {
          reason: `Consistency halt: today $${halt.today_net.toFixed(0)} = ${(halt.ratio * 100).toFixed(1)}% of total $${halt.total_net.toFixed(0)} (≥ ${(halt.threshold * 100).toFixed(0)}% limit)`,
          source: "llm_trader",
        },
      });
      return true;
    }
  }
  return false;
}
