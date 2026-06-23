/**
 * Position-opening + broker-mirror logging. Extracted from entry.ts in
 * CB.C1 (2026-06-20). The single canonical site where:
 *  - A `paper_positions` row gets INSERTed for a new entry
 *  - The cohort attribution + entry_reason JSONB is composed
 *  - The risk-pool halt is evaluated against committed broker exposure
 *  - The broker mirror (`executeLiveEntry`) is invoked when live
 *
 * Imported by:
 *  - entry.ts → `openPosition` (deterministic entry path)
 *  - entry-llm-trader.ts → `openPosition` (LLM-decided entry path) +
 *    `AlgoContext` type
 *
 * The `snapshotCondition` import comes from entry-conviction.ts — the
 * single serialiser used both here (for entry_reason) and in
 * checkEntryConditions (for the no-action breakdown).
 */
import {
  computeSlDistance,
  computeTpDistance,
  takeProfitRuleForSide,
  type AdaptiveTpContext,
} from "@/lib/algorithm/structural-sl";
import { pnlInUsd } from "@/lib/constants/markets";
import type { PriceBar } from "@/lib/market-data/types";
import type { SignalResult } from "@/lib/signals/evaluate-live";
import type { EntryCohort } from "@/lib/validators/position";
import type {
  AlgorithmRules,
  PatternCondition,
  TechnicalCondition,
} from "@/types/algorithm";
import type { PaperPosition, PositionEvent } from "@/types/position";
// CB.H1 pass 12 (2026-06-22): cohort + entry_reason extracted.
import { buildEntryCohort, buildEntryReason } from "./entry-cohort";
// CB.H1 pass 12 (2026-06-22): lot derivation + log+mirror extracted.
import { deriveLotSizingForMirror, logOpenAndMirror } from "./entry-open-mirror";
import { resolveRulesForCurrentRegime } from "@/lib/algorithm/regime-routing";
import { calculatePositionSize, calculateRiskPrices, logActivity } from "./helpers";
import { buildVolTargetLiveContext } from "./vol-target-live-context";
import type { BrokerExecutionContext } from "./live-execution";
import { checkRiskPoolHalt } from "./risk-pool-halt";
import type { SupabaseClient } from "@supabase/supabase-js";

/** AlgoContext is the shape of "the algo whose entry is being evaluated".
 *  Both the deterministic entry path (evaluateEntry) and the LLM path
 *  (evaluateLlmTraderEntry) construct one and pass into openPosition. */
export interface AlgoContext {
  id: string;
  name: string;
  description: string;
  rules: AlgorithmRules;
  capital: number;
}

/** Options-bag for openPosition (CB.C1.b, 2026-06-20). Replaces the
 *  original 14-positional-param signature. Ordering: hard-required infra
 *  → market context → entry-specific fired conditions → optional bars +
 *  cohort. */
export interface OpenPositionOptions {
  supabase: SupabaseClient;
  userId: string;
  algo: AlgoContext;
  ticker: string;
  currentPrice: number;
  conditions: Array<TechnicalCondition | PatternCondition>;
  sentimentResult: SignalResult | undefined;
  allOpenPositions: PaperPosition[];
  brokerCtx: BrokerExecutionContext | null;
  /** Conviction multiplier applied to position size (default 1). Used by
   *  the `conviction_scaled` sizing type to scale risk up/down by gate
   *  alignment. Deterministic path computes this from `pickConvictionMultiplier`;
   *  LLM-trader path always passes 1. */
  convictionMult?: number;
  /** Recent bars used to resolve structural SL/TP (swing_anchor /
   *  rr_multiple rule types). The current bar is bars[bars.length - 1]
   *  by convention; live entries always evaluate at "now". Optional —
   *  for percentage / fixed / pips rules the helpers fall through to
   *  their existing behaviour. */
  bars?: PriceBar[];
  /** Adaptive TP context — when provided, regime + daily-ATR
   *  awareness tightens the resolved TP distance. Pattern-based
   *  callers omit this; LLM-trader callers compute it from
   *  `evaluation.regime` + dailyBars and pass through. */
  adaptiveTpCtx?: AdaptiveTpContext;
  /** Per-trade cohort attribution — captured at entry time and stored
   *  in entry_reason.cohort. Foundation for Phase 3 cohort-based gates
   *  (auto-skip degrading cohorts). Started 2026-05-18 so by the time
   *  Phase 3 builds, enough cohort-tagged data has accumulated to
   *  slice on. Caller-provided pieces (regime) merged with locally
   *  computed pieces (entry_zone, position_in_range_pct, entry_hour_utc).
   *  Optional — pre-instrumentation callers and pattern-strategy callers
   *  may pass undefined; Phase 3 gates must handle null cohort gracefully.
   *
   *  WARNING — `entry_hour_utc` is the wall-clock UTC hour of the
   *  openPosition call (00/04/08/12/16/20 UTC for the flagship's 4h
   *  throttle gate), NOT the bar's UTC hour. OANDA H4 bars are aligned
   *  to NY 17:00 (01/05/09/13/17/21 UTC in EDT). For bar-aligned hour
   *  analysis use `llm_decisions.bar_date.getUTCHours()` instead — that's
   *  what `scripts/cohort-report.ts:346` reads, and what live + backtest
   *  share. See investigation notes 2026-06-15. */
  cohortFromCaller?: Partial<EntryCohort>;
  /** Native daily bars for LEVEL-based TP rules (prior_day_extreme) —
   *  the level is the previous UTC day's extreme, so the rule silently
   *  falls back to its RR value when this is omitted. Both entry paths
   *  thread their existing dailyBars here. */
  dailyBarsForLevels?: PriceBar[] | null;
}

export async function openPosition(
  options: OpenPositionOptions
): Promise<{ opened: number; openEvent?: PositionEvent; paperPositionId?: string }> {
  const {
    supabase,
    userId,
    algo,
    ticker,
    currentPrice,
    conditions,
    sentimentResult,
    allOpenPositions,
    brokerCtx,
    convictionMult = 1,
    bars,
    adaptiveTpCtx,
    cohortFromCaller,
    dailyBarsForLevels,
  } = options;
  // H.6-live-routing: when regime_routing.enabled, classify the current
  // bar's vol regime and merge the matching override into the rules.
  // The shadowed `effectiveAlgo` is what every downstream call reads —
  // computeSlTpDistances + calculatePositionSize + calculateRiskPrices
  // all see the routed parameters as-if-deployed. When routing is off
  // OR no override applies, effectiveAlgo === algo (zero overhead).
  const routed = resolveRulesForCurrentRegime(algo.rules, bars ?? []);
  const effectiveAlgo = routed.applied ? { ...algo, rules: routed.rules } : algo;
  if (routed.applied) {
    await logActivity(supabase, userId, {
      algorithm_id: algo.id,
      event_type: "regime_route_switched",
      ticker,
      details: {
        regime: routed.regime,
        applied_fields: routed.applied_fields,
        before: {
          rr_multiple: (algo.rules.take_profit as { type?: string; value?: number }).type === "rr_multiple" ? (algo.rules.take_profit as { value?: number }).value : null,
          sl_lookback: (algo.rules.stop_loss as { type?: string; lookback?: number }).type === "swing_anchor" ? (algo.rules.stop_loss as { lookback?: number }).lookback : null,
          risk_per_trade_pct: algo.rules.position_sizing.type === "risk_per_trade" ? algo.rules.position_sizing.value : null,
          regime_filter: Boolean((algo.rules as { regime_filter?: { enabled?: boolean } }).regime_filter?.enabled),
          adx_filter: Boolean((algo.rules as { adx_filter?: { enabled?: boolean } }).adx_filter?.enabled),
        },
        after: {
          rr_multiple: (effectiveAlgo.rules.take_profit as { type?: string; value?: number }).type === "rr_multiple" ? (effectiveAlgo.rules.take_profit as { value?: number }).value : null,
          sl_lookback: (effectiveAlgo.rules.stop_loss as { type?: string; lookback?: number }).type === "swing_anchor" ? (effectiveAlgo.rules.stop_loss as { lookback?: number }).lookback : null,
          risk_per_trade_pct: effectiveAlgo.rules.position_sizing.type === "risk_per_trade" ? effectiveAlgo.rules.position_sizing.value : null,
          regime_filter: Boolean((effectiveAlgo.rules as { regime_filter?: { enabled?: boolean } }).regime_filter?.enabled),
          adx_filter: Boolean((effectiveAlgo.rules as { adx_filter?: { enabled?: boolean } }).adx_filter?.enabled),
        },
      },
    });
  }

  const openValue = computeMarginUsed(effectiveAlgo, allOpenPositions);
  const side = resolveSide(effectiveAlgo);
  const { slDistance, tpDistance } = computeSlTpDistances(effectiveAlgo, side, currentPrice, ticker, bars, adaptiveTpCtx, dailyBarsForLevels);

  // G.3-followup: vol_target sizing needs ATR + recent R-multiples
  // pre-fetched. Skip the DB hit for the common-case sizing types.
  // When sizing is vol_target but bars are missing (pattern-strategy
  // entry path that doesn't thread bars through), the call surfaces the
  // ATR-can't-compute → instrumentVolPct=0 path which the math handles
  // via min_vol_floor.
  const volTargetCtx = effectiveAlgo.rules.position_sizing.type === "vol_target"
    ? await buildVolTargetLiveContext(supabase, effectiveAlgo.id, bars ?? [], currentPrice)
    : undefined;
  const sizing = calculatePositionSize(
    effectiveAlgo.rules,
    effectiveAlgo.capital,
    openValue,
    currentPrice,
    ticker,
    convictionMult,
    slDistance,
    volTargetCtx
  );
  if (!sizing) return { opened: 0 };

  const { stopLossPrice, takeProfitPrice } = calculateRiskPrices(
    currentPrice,
    effectiveAlgo.rules,
    side,
    ticker,
    slDistance,
    tpDistance
  );

  // Risk-pool halt — only on live algos (broker conn present) AND when
  // slDistance is known. Backstop against correlated-day combined-DLL.
  if (
    brokerCtx?.conn?.id &&
    slDistance != null &&
    (await tripRiskPoolHalt({ supabase, userId, algo, ticker, brokerCtx, side, currentPrice, slDistance, sizing }))
  ) {
    return { opened: 0 };
  }

  const position = await insertPaperPositionRow({
    supabase, userId, algo: effectiveAlgo, ticker, side, sizing, currentPrice, stopLossPrice,
    takeProfitPrice, bars, cohortFromCaller, conditions, sentimentResult,
  });
  if (!position) return { opened: 0 };
  await logOpenAndMirror({
    supabase, userId, algoId: effectiveAlgo.id, algoCapital: effectiveAlgo.capital,
    paperPositionId: position.id, ticker, side, sizing, currentPrice,
    stopLossPrice, takeProfitPrice, brokerCtx,
    lots: deriveLotSizingForMirror(effectiveAlgo.rules, ticker, sizing.quantity),
    divergenceRule: effectiveAlgo.rules.divergence_kill,
  });
  return {
    opened: 1,
    openEvent: { ticker, reason: "entry_signal", pnl: 0, price: currentPrice },
    paperPositionId: position.id,
  };
}

interface InsertPositionArgs {
  supabase: SupabaseClient;
  userId: string;
  algo: AlgoContext;
  ticker: string;
  side: "long" | "short";
  sizing: { quantity: number; notionalValue: number };
  currentPrice: number;
  stopLossPrice: number;
  takeProfitPrice: number;
  bars: PriceBar[] | undefined;
  cohortFromCaller: OpenPositionOptions["cohortFromCaller"];
  conditions: OpenPositionOptions["conditions"];
  sentimentResult: OpenPositionOptions["sentimentResult"];
}

/** Build cohort attribution + entry_reason JSONB, then INSERT the
 *  paper_positions row. Returns `null` when insert fails. */
async function insertPaperPositionRow(a: InsertPositionArgs): Promise<{ id: string } | null> {
  const cohort = buildEntryCohort(a.bars, a.currentPrice, a.cohortFromCaller);
  const entryReason = buildEntryReason(a.conditions, a.sentimentResult, cohort);
  const { data } = await a.supabase
    .from("paper_positions")
    .insert({
      user_id: a.userId,
      algorithm_id: a.algo.id,
      ticker: a.ticker,
      side: a.side,
      quantity: a.sizing.quantity,
      notional_value: a.sizing.notionalValue,
      entry_price: a.currentPrice,
      current_price: a.currentPrice,
      entry_reason: entryReason,
      stop_loss_price: a.stopLossPrice,
      // Write-once snapshot of the entry-to-SL distance. stop_loss_price
      // gets mutated by LLM `move_be` decisions, which destroys the
      // original 1R needed to compute R-multiples on close.
      initial_stop_loss_price: a.stopLossPrice,
      take_profit_price: a.takeProfitPrice,
    })
    .select("id")
    .single();
  return data as { id: string } | null;
}

/** Compute total margin used across open positions. For leveraged sizing
 *  (lots/risk_per_trade/conviction_scaled) sum notional/leverage so 3
 *  forex positions at 1:100 don't appear to consume the whole account. */
function computeMarginUsed(algo: AlgoContext, allOpenPositions: PaperPosition[]): number {
  const sizing0 = algo.rules.position_sizing;
  const isLeveraged =
    sizing0.type === "lots" ||
    sizing0.type === "risk_per_trade" ||
    sizing0.type === "conviction_scaled";
  const lev = algo.rules.leverage ?? 30;
  return allOpenPositions.reduce(
    (sum, p) => sum + (isLeveraged ? p.notional_value / lev : p.notional_value),
    0
  );
}

/** Resolve concrete side. Caller (evaluateEntry) sets this — at this point
 *  it's never "auto". Defaults to long for legacy callers. */
function resolveSide(algo: AlgoContext): "long" | "short" {
  return algo.rules.side === "long" || algo.rules.side === "short"
    ? algo.rules.side
    : "long";
}

/** Compute SL/TP distances ONCE before sizing — risk_per_trade lots
 *  depend on slDistance, rr_multiple TP depends on the resolved SL
 *  distance. For non-structural rules the helpers fall through to
 *  priceDeltaForRule via the caller's bars. */
function computeSlTpDistances(
  algo: AlgoContext,
  side: "long" | "short",
  currentPrice: number,
  ticker: string,
  bars: PriceBar[] | undefined,
  adaptiveTpCtx: AdaptiveTpContext | undefined,
  dailyBarsForLevels: PriceBar[] | null | undefined
): { slDistance: number | undefined; tpDistance: number | undefined } {
  if (!bars || bars.length === 0) return { slDistance: undefined, tpDistance: undefined };
  const entryIdx = bars.length - 1;
  const slDistance = computeSlDistance(algo.rules.stop_loss, side, currentPrice, ticker, bars, entryIdx);
  if (slDistance === undefined) return { slDistance, tpDistance: undefined };
  const tpDistance = computeTpDistance(
    takeProfitRuleForSide(algo.rules, side),
    slDistance,
    currentPrice,
    ticker,
    adaptiveTpCtx,
    dailyBarsForLevels && dailyBarsForLevels.length > 0
      ? { side, entryDate: bars[bars.length - 1].date, dailyBars: dailyBarsForLevels }
      : undefined
  );
  return { slDistance, tpDistance };
}

interface RiskPoolArgs {
  supabase: SupabaseClient;
  userId: string;
  algo: AlgoContext;
  ticker: string;
  brokerCtx: NonNullable<OpenPositionOptions["brokerCtx"]>;
  side: "long" | "short";
  currentPrice: number;
  slDistance: number;
  sizing: { quantity: number };
}

/** Run the risk-pool halt check + log + return true when tripped. */
async function tripRiskPoolHalt(a: RiskPoolArgs): Promise<boolean> {
  const { supabase, userId, algo, ticker, brokerCtx, side, currentPrice, slDistance, sizing } = a;
  const proposedRiskUsd = pnlInUsd(
    ticker,
    side,
    currentPrice,
    side === "long" ? currentPrice - slDistance : currentPrice + slDistance,
    sizing.quantity
  );
  const cap = algo.rules.prop_firm?.combined_risk_cap_pct ?? undefined;
  const halt = await checkRiskPoolHalt(
    supabase,
    brokerCtx.conn.id,
    algo.capital,
    Math.abs(proposedRiskUsd),
    cap
  );
  if (!halt.tripped) return false;
  await logActivity(supabase, userId, {
    algorithm_id: algo.id,
    event_type: "signal_no_action",
    ticker,
    details: {
      reason: `Risk-pool halt: combined ${halt.combinedRiskPct.toFixed(2)}% (current ${halt.currentRiskPct.toFixed(2)}% + proposed ${halt.proposedRiskPct.toFixed(2)}%) exceeds cap ${halt.capPct.toFixed(2)}% — ${algo.rules.side ?? "long"} ${ticker} entry refused to keep portfolio exposure under FTMO DLL margin`,
      source: "risk_pool_halt",
      current_risk_pct: halt.currentRiskPct,
      proposed_risk_pct: halt.proposedRiskPct,
      combined_risk_pct: halt.combinedRiskPct,
      cap_pct: halt.capPct,
    },
  });
  return true;
}
