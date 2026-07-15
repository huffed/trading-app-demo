/**
 * Deterministic-path entry gates — the pre-conditions ladder that runs
 * before condition evaluation in the non-LLM entry path. Each gate either
 * logs `signal_no_action` and returns `{blocked: true}` OR passes through.
 * Extracted from `entry.ts` on 2026-06-22 (CB.H1 pass 16).
 *
 * Gate order (mirrors original inline sequence):
 *  0. Bar staleness (E2.24.b — was LLM-path-only; a provider outage
 *     otherwise lets the ladder evaluate a days-old bar at a live price)
 *  1. Intraday ATR liquidity
 *  2. News veto
 *  3. R-aware consecutive-loss halt
 *  3b. Re-entry cooldown (E2.24.b — was LLM-path-only; without it an
 *      intra-bar stop-out re-fires on the same closed bar every 15-min
 *      scan until the consec-loss halt has TWO closed losses to count)
 *  4. Time-of-day filter (per-hour WR)
 *  5. FTMO consistency rule
 *  6. Market-state gate (regime-library dormancy)
 *  7. Side resolution + direction conflict
 *  8. DXY directional filter
 *  9. Regime (ATR percentile)
 * 10. ADX trend strength
 *
 * Returns the resolved side + higherTfBars + liquidity result on
 * pass-through so the caller can thread them into condition evaluation
 * + the openPosition call.
 */
import { checkBarStaleness } from "@/lib/algorithm/bar-staleness-gate";
import { checkAtrLiquidity, type AtrLiquidityResult } from "@/lib/algorithm/intraday-atr-gate";
import { checkReEntryCooldown } from "@/lib/algorithm/re-entry-cooldown";
import {
  checkMarketStateGateConfig,
  computePositionInRangePct,
  gateConfigModeLabel,
  type GateContext,
} from "@/lib/algorithm/market-state-gate";
import { checkTimeOfDayFilter } from "@/lib/algorithm/time-of-day-filter";
import type { PriceBar } from "@/lib/market-data/types";
import { checkConsecutiveLossHalt } from "./consec-loss-halt";
import { checkConsistencyHalt } from "./consistency-halt";
import type { EntryContext } from "./entry";
import { checkNewsVeto, computeLiveMarketState } from "./entry-gates";
// CB.H1 pass 18b (2026-06-22): steps 7-11 (side resolution + post-side
// directional gates) extracted to entry-side-and-direction-gates.ts.
import { runSideAndDirectionGates } from "./entry-side-and-direction-gates";
import { logActivity } from "./helpers";
import { getPerHourStats } from "./per-hour-stats";
import type { SupabaseClient } from "@supabase/supabase-js";

export type DeterministicGatesResult =
  | { blocked: true }
  | {
      blocked: false;
      side: "long" | "short";
      directionOverride?: "bullish" | "bearish";
      higherTfBars: PriceBar[];
      liquidity: AtrLiquidityResult;
      currentPrice: number;
    };

export async function runDeterministicEntryGates(
  ctx: EntryContext
): Promise<DeterministicGatesResult> {
  const { supabase, userId, algo, ticker, bars, closes, livePrice, dailyBars, dxyBars } = ctx;
  const rules = algo.rules;
  const currentPrice = livePrice ?? closes[closes.length - 1];

  // Step 0: bar staleness — refuse to evaluate a bar that should have
  // rolled over already (provider-outage stale-cache protection).
  const staleness = checkBarStaleness({
    timeframe: rules.timeframe,
    lastBarDate: bars.length > 0 ? bars[bars.length - 1].date : null,
  });
  if (staleness.block) {
    await logActivity(supabase, userId, {
      algorithm_id: algo.id,
      event_type: "signal_no_action",
      ticker,
      details: {
        reason: staleness.reason ?? "Bar-staleness gate triggered",
        source: "deterministic",
        bar_age_minutes: staleness.bar_age_minutes,
        threshold_minutes: staleness.threshold_minutes,
        last_bar_date: staleness.last_bar_date,
      },
    });
    return { blocked: true };
  }

  // Step 1: ATR liquidity (also surfaces liquidity for the result payload)
  const liquidity = checkAtrLiquidity(bars, bars.length - 1);
  if (liquidity.skip) {
    await logActivity(supabase, userId, {
      algorithm_id: algo.id,
      event_type: "signal_no_action",
      ticker,
      details: {
        reason: liquidity.reason ?? "ATR liquidity gate triggered",
        atr_current: liquidity.atr_current,
        atr_threshold: liquidity.atr_threshold,
      },
    });
    return { blocked: true };
  }

  // Steps 2-6 (news veto, consec halt, time filter, consistency rule,
  // market-state gate) extracted to runPreSideHalts for size-cap fit.
  const preSideBlocked = await runPreSideHalts({
    supabase,
    userId,
    algo,
    ticker,
    rules,
    bars,
    dailyBars,
    dxyBars,
    currentPrice,
  });
  if (preSideBlocked) return { blocked: true };

  // Steps 7-11: side resolution + post-side gates (extracted pass 18b).
  const sideResult = await runSideAndDirectionGates({
    supabase,
    userId,
    algoId: algo.id,
    ticker,
    rules,
    bars,
    dailyBars,
    dxyBars,
  });
  if (sideResult.blocked) return { blocked: true };

  return {
    blocked: false,
    side: sideResult.side,
    directionOverride: sideResult.directionOverride,
    higherTfBars: sideResult.higherTfBars,
    liquidity,
    currentPrice,
  };
}

interface PreSideHaltsArgs {
  supabase: SupabaseClient;
  userId: string;
  algo: EntryContext["algo"];
  ticker: string;
  rules: EntryContext["algo"]["rules"];
  bars: PriceBar[];
  dailyBars: EntryContext["dailyBars"];
  dxyBars: EntryContext["dxyBars"];
  currentPrice: number;
}

/** Steps 2-6 of the deterministic gate ladder. Returns true when ANY of
 *  the 5 gates blocked. Extracted from runDeterministicEntryGates for
 *  CB.H2 fit. */
async function runPreSideHalts(a: PreSideHaltsArgs): Promise<boolean> {
  const { supabase, userId, algo, ticker, rules, bars, dailyBars, dxyBars, currentPrice } = a;
  const vetoBlocked = await runNewsAndConsecHalts({ supabase, userId, algoId: algo.id, ticker, rules });
  if (vetoBlocked) return true;
  if (rules.time_filter?.enabled) {
    const stats = await getPerHourStats(supabase, algo.id, {
      min_samples: rules.time_filter.min_samples,
      window_days: rules.time_filter.window_days,
    });
    const currentHour = new Date().getUTCHours();
    const tod = checkTimeOfDayFilter(rules.time_filter, stats.get(currentHour));
    if (tod.block) {
      await logActivity(supabase, userId, {
        algorithm_id: algo.id,
        event_type: "signal_no_action",
        ticker,
        details: {
          reason: tod.reason ?? "Time-of-day filter triggered",
          hour_utc: tod.hour,
          hour_wr_pct: tod.hour_wr_pct,
          hour_samples: tod.hour_samples,
        },
      });
      return true;
    }
  }
  const consistencyPct = rules.prop_firm?.consistency_rule ?? 0;
  if (consistencyPct > 0) {
    const halt = await checkConsistencyHalt(supabase, algo.id, consistencyPct);
    if (halt.tripped) {
      await logActivity(supabase, userId, {
        algorithm_id: algo.id,
        event_type: "signal_no_action",
        ticker,
        details: {
          reason: `Consistency halt: today $${halt.today_net.toFixed(0)} = ${(halt.ratio * 100).toFixed(1)}% of total $${halt.total_net.toFixed(0)} (≥ ${(halt.threshold * 100).toFixed(0)}% limit)`,
          today_net: halt.today_net,
          total_net: halt.total_net,
          ratio: halt.ratio,
          threshold: halt.threshold,
        },
      });
      return true;
    }
  }
  if (rules.market_state_gate) {
    const blocked = await runMarketStateGate({
      supabase,
      userId,
      algo,
      ticker,
      rules,
      bars,
      dailyBars,
      dxyBars,
      currentPrice,
    });
    if (blocked) return true;
  }
  return false;
}

interface NewsConsecHaltsArgs {
  supabase: SupabaseClient;
  userId: string;
  algoId: string;
  ticker: string;
  rules: EntryContext["algo"]["rules"];
}

/** Steps 2-3 — news veto + R-aware consecutive-loss halt. */
async function runNewsAndConsecHalts(a: NewsConsecHaltsArgs): Promise<boolean> {
  const { supabase, userId, algoId, ticker, rules } = a;
  const veto = await checkNewsVeto(rules, ticker);
  if (veto.vetoed) {
    await logActivity(supabase, userId, {
      algorithm_id: algoId,
      event_type: "signal_no_action",
      ticker,
      details: { reason: `News veto: ${veto.reason}` },
    });
    return true;
  }
  const consecHalt = rules.prop_firm?.consecutive_loss_daily_halt ?? 0;
  if (consecHalt > 0) {
    const halt = await checkConsecutiveLossHalt(supabase, algoId, consecHalt);
    if (halt.tripped) {
      await logActivity(supabase, userId, {
        algorithm_id: algoId,
        event_type: "signal_no_action",
        ticker,
        details: {
          reason: `Consecutive-loss halt: ${halt.streak}/${halt.threshold} losses today`,
        },
      });
      return true;
    }
  }
  // Step 3b: re-entry cooldown — one fresh bar of information after a
  // loss exit before the same algo+ticker may re-enter.
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
        source: "deterministic",
      },
    });
    return true;
  }
  return false;
}

/** Step 6 — market-state gate. Surfaces shadow_block as a log without
 *  blocking; surfaces actual block as a log + return. */
async function runMarketStateGate(a: PreSideHaltsArgs): Promise<boolean> {
  const { supabase, userId, algo, ticker, rules, bars, dailyBars, dxyBars, currentPrice } = a;
  if (!rules.market_state_gate) return false;
  const marketState = await computeLiveMarketState(
    ticker,
    rules.timeframe,
    bars,
    dailyBars,
    dxyBars
  );
  const gateCtx: GateContext = {
    entryHourUtc: new Date().getUTCHours(),
    positionInRangePct: computePositionInRangePct(bars, currentPrice),
  };
  const verdict = checkMarketStateGateConfig(rules.market_state_gate, marketState, gateCtx);
  const gateMode = gateConfigModeLabel(rules.market_state_gate);
  if (verdict.shadow_block_reason) {
    await logActivity(supabase, userId, {
      algorithm_id: algo.id,
      event_type: "signal_no_action",
      ticker,
      details: {
        reason: "market_state_gate_shadow",
        gate_mode: gateMode,
        would_block: verdict.shadow_block_reason,
        market_state: marketState,
        entry_hour_utc: gateCtx.entryHourUtc,
        position_in_range_pct: gateCtx.positionInRangePct,
      },
    });
  }
  if (!verdict.allowed) {
    await logActivity(supabase, userId, {
      algorithm_id: algo.id,
      event_type: "signal_no_action",
      ticker,
      details: {
        reason: "market_state_gate",
        gate_mode: gateMode,
        verdict: verdict.reason,
        market_state: marketState,
        entry_hour_utc: gateCtx.entryHourUtc,
        position_in_range_pct: gateCtx.positionInRangePct,
      },
    });
    return true;
  }
  return false;
}
