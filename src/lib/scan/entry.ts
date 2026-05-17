/**
 * Entry evaluation — checks if conditions are met and opens a new position.
 */
import {
  convictionMultiplier,
  convictionMultiplierByTfAgreement,
} from "@/lib/algorithm/conviction-sizing";
import { checkDxyDirection } from "@/lib/algorithm/dxy-filter";
import { checkBarStaleness } from "@/lib/algorithm/bar-staleness-gate";
import { checkAtrLiquidity } from "@/lib/algorithm/intraday-atr-gate";
import { checkLivePriceDrift } from "@/lib/algorithm/live-price-drift-gate";
import { checkReEntryCooldown } from "@/lib/algorithm/re-entry-cooldown";
import { checkBrokerSpread, type SpreadGateResult } from "@/lib/algorithm/spread-gate";
import {
  computeSlDistance,
  computeTpDistance,
  dailyAtrFromBars,
  type AdaptiveTpContext,
} from "@/lib/algorithm/structural-sl";
import { checkTimeOfDayFilter } from "@/lib/algorithm/time-of-day-filter";
import { getContractSize, pnlInUsd } from "@/lib/constants/markets";
import { isWeakTrendByAdx } from "@/lib/market-data/adx-filter";
import { parseBarDate } from "@/lib/market-data/parse-bar-date";
import { resolveSide } from "@/lib/market-data/auto-side";
import {
  collectOtherTimeframes,
  countTimeframesAgreeing,
  evaluateConditionsDetailed,
  normalize,
  type Cache,
} from "@/lib/market-data/backtest-engine";
import type { BarsBundle } from "@/lib/market-data/condition-evaluator";
import {
  fetchEconomicCalendar,
  getEventCurrencies,
  isWithinVetoWindow,
} from "@/lib/market-data/economic-calendar";
import { isRangingByAtr } from "@/lib/market-data/regime-filter";
import { resampleTo, resampleToDaily } from "@/lib/market-data/resample";
import type { PriceBar } from "@/lib/market-data/types";
import { evaluateLiveSignal, type SignalResult } from "@/lib/signals/evaluate-live";
import { entryReasonSchema } from "@/lib/validators/position";
import {
  isPatternCondition,
  isSentimentCondition,
  isTechnicalCondition,
  type AlgorithmRules,
  type PatternCondition,
  type TechnicalCondition,
} from "@/types/algorithm";
import type { PaperPosition, PositionEvent } from "@/types/position";
import { checkConsecutiveLossHalt } from "./consec-loss-halt";
import { checkConsistencyHalt } from "./consistency-halt";
import { calculatePositionSize, calculateRiskPrices, logActivity } from "./helpers";
import { executeLiveEntry, executeLiveExit, type BrokerExecutionContext } from "./live-execution";
import { evaluateLlmTrader, isBarCloseScan, type LlmTraderContext } from "./llm-trader";
import { linkLlmDecisionToPosition, recordLlmDecision } from "./llm-trader-audit";
import { summariseRecentOutcomes } from "./llm-trader-reflection";
import { getPerHourStats } from "./per-hour-stats";
import { checkRiskPoolHalt } from "./risk-pool-halt";
import type { SupabaseClient } from "@supabase/supabase-js";

interface AlgoContext {
  id: string;
  name: string;
  description: string;
  rules: AlgorithmRules;
  capital: number;
}

/** Serialise a fired condition into the entry_reason.conditions_met blob.
 *  Different condition types carry different fields — caller iterates the
 *  mixed list and uses this to flatten each one to a uniform shape. */
function snapshotCondition(c: TechnicalCondition | PatternCondition) {
  if (c.type === "technical") {
    return { type: c.type, indicator: c.indicator, operator: c.operator, value: c.value };
  }
  return {
    type: c.type,
    pattern: c.pattern,
    direction: c.direction,
    lookback: c.lookback,
    ma_period: c.ma_period,
  };
}

async function openPosition(
  supabase: SupabaseClient,
  userId: string,
  algo: AlgoContext,
  ticker: string,
  currentPrice: number,
  conditions: Array<TechnicalCondition | PatternCondition>,
  sentimentResult: SignalResult | undefined,
  allOpenPositions: PaperPosition[],
  brokerCtx: BrokerExecutionContext | null,
  convictionMult: number = 1,
  /** Recent bars used to resolve structural SL/TP (swing_anchor /
   *  rr_multiple rule types). The current bar is bars[bars.length - 1]
   *  by convention; live entries always evaluate at "now". Optional —
   *  for percentage / fixed / pips rules the helpers fall through to
   *  their existing behaviour. */
  bars?: PriceBar[],
  /** Adaptive TP context — when provided, regime + daily-ATR
   *  awareness tightens the resolved TP distance. Pattern-based
   *  callers omit this; LLM-trader callers compute it from
   *  `evaluation.regime` + dailyBars and pass through. */
  adaptiveTpCtx?: AdaptiveTpContext
): Promise<{ opened: number; openEvent?: PositionEvent; paperPositionId?: string }> {
  // calculatePositionSize wants MARGIN-used summed, not notional. For
  // leveraged sizing (lots / risk_per_trade / conviction_scaled) sum
  // notional / leverage so 3 forex positions at 1:100 don't appear to
  // consume the whole account.
  const sizing0 = algo.rules.position_sizing;
  const isLeveraged =
    sizing0.type === "lots" ||
    sizing0.type === "risk_per_trade" ||
    sizing0.type === "conviction_scaled";
  const lev = algo.rules.leverage ?? 30;
  const openValue = allOpenPositions.reduce(
    (sum, p) => sum + (isLeveraged ? p.notional_value / lev : p.notional_value),
    0
  );

  // Side is resolved by the caller (evaluateEntry) — at this point it's
  // a concrete long/short, never "auto". Default to long for legacy callers.
  const side: "long" | "short" =
    algo.rules.side === "long" || algo.rules.side === "short"
      ? algo.rules.side
      : "long";

  // Compute SL/TP distances ONCE before sizing — risk_per_trade lots
  // depend on slDistance, and rr_multiple TP depends on the resolved
  // SL distance. For non-structural rules the helpers fall through to
  // priceDeltaForRule via the caller's bars (or skip when bars omitted).
  const entryIdx = bars && bars.length > 0 ? bars.length - 1 : 0;
  const slDistance =
    bars && bars.length > 0
      ? computeSlDistance(algo.rules.stop_loss, side, currentPrice, ticker, bars, entryIdx)
      : undefined;
  const tpDistance =
    bars && bars.length > 0 && slDistance !== undefined
      ? computeTpDistance(
          algo.rules.take_profit,
          slDistance,
          currentPrice,
          ticker,
          adaptiveTpCtx
        )
      : undefined;

  const sizing = calculatePositionSize(
    algo.rules,
    algo.capital,
    openValue,
    currentPrice,
    ticker,
    convictionMult,
    slDistance
  );
  if (!sizing) {
    return { opened: 0 };
  }

  const { stopLossPrice, takeProfitPrice } = calculateRiskPrices(
    currentPrice,
    algo.rules,
    side,
    ticker,
    slDistance,
    tpDistance
  );

  // Risk-pool halt — applies only when this algo lives on a broker
  // connection (live trading). Aggregates open-position risk across all
  // algos sharing the same broker; refuses entry when (combined +
  // proposed) would exceed the cap. Backstop against multi-algo
  // momentum-correlated days where every algo fires into the same setup
  // and combined exposure breaches FTMO 5% DLL.
  //
  // Ignored when:
  //  - No broker (paper/backtest)
  //  - SL distance unknown (no risk to measure; openPosition has other
  //    safety checks like position-size sanity gate)
  if (brokerCtx?.conn?.id && slDistance != null) {
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
    if (halt.tripped) {
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
      return { opened: 0 };
    }
  }

  const entryReason = entryReasonSchema.parse({
    conditions_met: conditions.map(snapshotCondition),
    signal_result: sentimentResult
      ? {
          signal: sentimentResult.signal,
          confidence: sentimentResult.confidence,
          reasoning: sentimentResult.reasoning,
        }
      : undefined,
  });

  const { data: position } = await supabase
    .from("paper_positions")
    .insert({
      user_id: userId,
      algorithm_id: algo.id,
      ticker,
      side,
      quantity: sizing.quantity,
      notional_value: sizing.notionalValue,
      entry_price: currentPrice,
      current_price: currentPrice,
      entry_reason: entryReason,
      stop_loss_price: stopLossPrice,
      // Write-once snapshot of the entry-to-SL distance. stop_loss_price
      // gets mutated by LLM `move_be` decisions, which destroys the
      // original 1R needed to compute R-multiples on close. Read this
      // when 1R must reflect entry-time risk (audit, halts).
      initial_stop_loss_price: stopLossPrice,
      take_profit_price: takeProfitPrice,
    })
    .select("id")
    .single();

  if (!position) return { opened: 0 };
  // Derive lots for the broker mirror. For "lots" sizing it's the rule
  // value verbatim. For "risk_per_trade" / "conviction_scaled" we back-
  // compute from the sized quantity (which calculatePositionSize already
  // produced via riskToLots). Other sizing types don't map to a
  // meaningful lot count → undefined.
  let lotSizing: number | undefined;
  if (algo.rules.position_sizing.type === "lots") {
    lotSizing = algo.rules.position_sizing.value;
  } else if (
    algo.rules.position_sizing.type === "risk_per_trade" ||
    algo.rules.position_sizing.type === "conviction_scaled"
  ) {
    const contract = getContractSize(ticker, algo.rules.asset_class);
    lotSizing = contract > 0 ? sizing.quantity / contract : undefined;
  }
  await logOpenAndMirror({
    supabase,
    userId,
    algoId: algo.id,
    algoCapital: algo.capital,
    paperPositionId: position.id,
    ticker,
    side,
    sizing,
    currentPrice,
    stopLossPrice,
    takeProfitPrice,
    brokerCtx,
    lots: lotSizing,
    divergenceRule: algo.rules.divergence_kill,
  });
  return {
    opened: 1,
    openEvent: { ticker, reason: "entry_signal", pnl: 0, price: currentPrice },
    paperPositionId: position.id,
  };
}

interface LogAndMirrorArgs {
  supabase: SupabaseClient;
  userId: string;
  algoId: string;
  algoCapital: number;
  paperPositionId: string;
  ticker: string;
  side: "long" | "short";
  sizing: { quantity: number; notionalValue: number };
  currentPrice: number;
  stopLossPrice: number;
  takeProfitPrice: number;
  brokerCtx: BrokerExecutionContext | null;
  /** When the algo uses lot-based sizing, this is the raw lot count.
   *  Threaded to executeLiveEntry so JPY crosses don't get mis-converted. */
  lots?: number;
  /** Optional cumulative divergence kill switch from algo rules. */
  divergenceRule?: { max_avg_bps: number; window_trades: number };
}

async function logOpenAndMirror(args: LogAndMirrorArgs): Promise<void> {
  await logActivity(args.supabase, args.userId, {
    algorithm_id: args.algoId,
    position_id: args.paperPositionId,
    event_type: "position_opened",
    ticker: args.ticker,
    details: {
      entry_price: args.currentPrice,
      quantity: args.sizing.quantity,
      notional_value: args.sizing.notionalValue,
      stop_loss_price: args.stopLossPrice,
      take_profit_price: args.takeProfitPrice,
    },
  });
  if (args.brokerCtx) {
    await executeLiveEntry({
      supabase: args.supabase,
      userId: args.userId,
      algorithmId: args.algoId,
      paperPositionId: args.paperPositionId,
      ticker: args.ticker,
      side: args.side,
      notionalUsd: args.sizing.notionalValue,
      currentPrice: args.currentPrice,
      stopLossPrice: args.stopLossPrice,
      takeProfitPrice: args.takeProfitPrice,
      ctx: args.brokerCtx,
      capital: args.algoCapital,
      lots: args.lots,
      divergenceRule: args.divergenceRule,
    });
  }
}

/** Refuse a new entry when any sibling algorithm (same user, different
 *  algorithm_id) already holds an OPEN position on the same ticker in
 *  the OPPOSITE direction. Two algos opening opposing positions on one
 *  instrument cancel out economically — the operator pays the spread
 *  twice while net exposure is zero. Diagnosed from 2026-04-30 live
 *  gold trades where Algo B opened SHORT XAU/USD and Algo D opened
 *  LONG XAU/USD 11 seconds apart. */
async function checkDirectionConflict(
  supabase: SupabaseClient,
  userId: string,
  algoId: string,
  ticker: string,
  proposedSide: "long" | "short"
): Promise<
  | { block: false }
  | { block: true; reason: string; conflicting_algorithm_ids: string[] }
> {
  const opposite: "long" | "short" = proposedSide === "long" ? "short" : "long";
  const { data, error } = await supabase
    .from("paper_positions")
    .select("algorithm_id")
    .eq("user_id", userId)
    .eq("ticker", ticker)
    .eq("status", "open")
    .eq("side", opposite)
    .neq("algorithm_id", algoId);
  if (error || !data || data.length === 0) return { block: false };
  const ids = Array.from(new Set(data.map((p) => p.algorithm_id as string)));
  return {
    block: true,
    reason: `Direction conflict: ${ids.length} sibling algo(s) hold opposing ${opposite} on ${ticker}`,
    conflicting_algorithm_ids: ids,
  };
}

async function checkNewsVeto(
  rules: AlgorithmRules,
  ticker: string
): Promise<{ vetoed: boolean; reason?: string }> {
  const v = rules.news_veto;
  if (!v?.enabled) return { vetoed: false };
  const currencies = getEventCurrencies(ticker);
  if (currencies.length === 0) return { vetoed: false };

  const now = new Date();
  const windowMs = Math.max(v.block_minutes_before, v.block_minutes_after) * 60 * 1000;
  const events = await fetchEconomicCalendar(
    new Date(now.getTime() - windowMs),
    new Date(now.getTime() + windowMs)
  );
  const hit = isWithinVetoWindow(
    now,
    events,
    currencies,
    v.block_minutes_before,
    v.block_minutes_after,
    v.min_impact
  );
  if (!hit) return { vetoed: false };
  return { vetoed: true, reason: `${hit.currency} ${hit.event} (${hit.impact} impact)` };
}

/**
 * Resolve the conviction multiplier from the gate result + rule. Same
 * dispatch logic as backtest-engine's `convictionMultiplierForRules`,
 * but operates on the already-computed counts so we don't re-evaluate
 * conditions a second time on the live path.
 */
function pickConvictionMultiplier(
  rules: AlgorithmRules,
  gate: { met: number; total: number; firedTfs: number; totalTfs: number }
): number {
  const sizing = rules.position_sizing;
  if (sizing.type !== "conviction_scaled") return 1;
  if (sizing.conviction_metric === "tf_agreement") {
    return convictionMultiplierByTfAgreement(gate.firedTfs, gate.totalTfs, sizing.max_multiplier);
  }
  return convictionMultiplier(rules.entry_logic, gate.met, gate.total, sizing.max_multiplier);
}

interface EntryConditionResult {
  /** True when the configured logic combinator (all / any / n_of_m) is
   *  satisfied. Caller uses this as the proceed/short-circuit gate. */
  pass: boolean;
  /** How many conditions actually fired. Threaded into conviction-scaled
   *  position sizing — more confluence above the n_of_m threshold = more
   *  size. Same numbers backtest and live use, so replay matches. */
  met: number;
  /** Total evaluable conditions (length of the technical + pattern list). */
  total: number;
  /** Per-condition fired/not-fired array, parallel to the input
   *  conditions list. Logged into signal_detected.details so the UI can
   *  show ✓/✗ per row. */
  fired: boolean[];
  /** Distinct timeframes with ≥1 firing condition. Used for the
   *  tf_agreement conviction metric on multi-TF templates. */
  firedTfs: number;
  /** Distinct timeframes referenced across the entry condition list. */
  totalTfs: number;
}

/** Evaluate the entry-condition gate (technical + pattern) and log a
 *  signal_no_action event when it fails. Returns the gate decision plus
 *  the alignment count, so the caller can drive conviction-based sizing
 *  without re-running the same evaluation. Sentiment is checked separately. */
async function checkEntryConditions(
  supabase: SupabaseClient,
  userId: string,
  algoId: string,
  ticker: string,
  conditions: Array<TechnicalCondition | PatternCondition>,
  bars: PriceBar[],
  closes: number[],
  primaryTimeframe: string,
  logic: AlgorithmRules["entry_logic"],
  directionOverride?: "bullish" | "bearish",
  dailyBars?: PriceBar[] | null
): Promise<EntryConditionResult> {
  if (conditions.length === 0) {
    return { pass: true, met: 0, total: 0, fired: [], firedTfs: 0, totalTfs: 0 };
  }
  const cache: Cache = new Map();
  // Prefer the dedicated D1 series when supplied; fall back to resampling
  // the primary so older callers and missing-cache paths still work.
  const higherTfBars = dailyBars ?? resampleToDaily(bars);
  // Multi-timeframe routing: build aligned bundles for any non-primary
  // timeframe a condition references. Live uses the LATEST bar in each
  // resampled series — no alignment-by-date needed since "now" is now.
  const otherTfs = collectOtherTimeframes(conditions, [], primaryTimeframe.toLowerCase());
  let byTimeframe: Map<string, BarsBundle> | undefined;
  if (otherTfs.length > 0) {
    byTimeframe = new Map();
    for (const tf of otherTfs) {
      const tfBars = resampleTo(bars, tf);
      if (tfBars.length === 0) continue;
      byTimeframe.set(tf, {
        bars: tfBars,
        closes: tfBars.map((b) => b.close),
        cache: new Map(),
        i: tfBars.length - 1,
      });
    }
  }
  const ctx = {
    cache,
    closes,
    bars,
    i: closes.length - 1,
    higherTfBars,
    directionOverride,
    byTimeframe,
    primaryTimeframe: primaryTimeframe.toLowerCase(),
  };
  const { met, total, fired } = evaluateConditionsDetailed(conditions, ctx);
  const { firedTfs, totalTfs } = countTimeframesAgreeing(conditions, ctx);
  let pass: boolean;
  if (logic === "all") pass = met === total;
  else if (logic === "any") pass = met > 0;
  else pass = typeof logic === "object" && logic.type === "n_of_m" ? met >= logic.n : met === total;
  if (pass) return { pass: true, met, total, fired, firedTfs, totalTfs };
  await logActivity(supabase, userId, {
    algorithm_id: algoId,
    event_type: "signal_no_action",
    ticker,
    details: {
      reason: "Entry conditions not met",
      conditions_met: met,
      conditions_total: total,
      conditions_breakdown: fired,
    },
  });
  return { pass: false, met, total, fired, firedTfs, totalTfs };
}

export async function evaluateEntry(
  supabase: SupabaseClient,
  userId: string,
  algo: AlgoContext,
  ticker: string,
  bars: PriceBar[],
  closes: number[],
  allOpenPositions: PaperPosition[],
  livePrice?: number | null,
  brokerCtx?: BrokerExecutionContext | null,
  dailyBars?: PriceBar[] | null,
  /** EUR/USD 1h bars for the DXY directional filter, fetched once per
   *  scan in scanAlgorithm. Optional — null when the filter is not
   *  configured on this algo, OR when the fetch failed (gate becomes
   *  no-op via no_data status). */
  dxyBars?: PriceBar[] | null,
  /** Intermarket series (silver / 10Y yield / VIX) for the LLM-trader's
   *  prompt context. Fetched once per scan when llm_trader is enabled
   *  on a commodity algo; null otherwise. Each sub-field is independent
   *  — partial data still produces a useful summariser line. */
  intermarket?: {
    silver?: PriceBar[];
    yield10y?: PriceBar[];
    vix?: PriceBar[];
  } | null,
  /** When set, this evaluation is dry-run — the position cap (max_positions
   *  / max_per_ticker) is full so we wouldn't open even if every gate
   *  passed. We still run the full gate ladder for telemetry (each gate
   *  logs signal_no_action with its own reason on failure), but at the
   *  would-have-opened step we emit a signal_no_action with this reason
   *  instead of placing the order. Lets the operator see "the strategy
   *  fired while capped" — without this flag, the cap silently dropped
   *  every potential entry and the considered feed showed nothing during
   *  slot-full windows. */
  cappedReason?: string | null,
  /** Operator-triggered scans (the "Scan now" button) bypass the cron-
   *  alignment bar-close gate so the LLM evaluates immediately on the
   *  most recent bars. Cron-driven scans pass false (default) so the
   *  bar-close timing matches how the backtest harness evaluated. Other
   *  defensive gates (ATR liquidity, news veto, halt checks, etc.) are
   *  unaffected — those are real protections, not timing artifacts. */
  force = false
): Promise<{ opened: number; openEvent?: PositionEvent }> {
  const rules = algo.rules;

  // LLM-trader path — discretionary AI replaces pattern-detect + threshold.
  // Validated on Anthropic Haiku 4.5 across 3 historical 60d windows
  // (20 trades · 65% WR · +20.2% · 0.75% peak DD). See llm-trader.ts +
  // commit 2bea3f3 for the full prompt + iteration history.
  if (rules.llm_trader?.enabled) {
    return evaluateLlmTraderEntry(
      supabase,
      userId,
      algo,
      ticker,
      bars,
      closes,
      allOpenPositions,
      livePrice,
      brokerCtx,
      dailyBars,
      dxyBars,
      intermarket,
      cappedReason,
      force
    );
  }

  // Use real-time price for entry, fall back to latest daily close
  const currentPrice = livePrice ?? closes[closes.length - 1];

  // Intraday ATR liquidity gate — adaptive replacement for the old
  // clock-time session filter. Skips entries when the most-recent
  // primary-timeframe ATR is unusually compressed (bottom 20% of the
  // last 200-bar distribution). Same module backtest uses, so live and
  // replay agree on whether a given moment was tradeable.
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
    return { opened: 0 };
  }

  const veto = await checkNewsVeto(rules, ticker);
  if (veto.vetoed) {
    await logActivity(supabase, userId, {
      algorithm_id: algo.id,
      event_type: "signal_no_action",
      ticker,
      details: { reason: `News veto: ${veto.reason}` },
    });
    return { opened: 0 };
  }

  // Soft consecutive-loss halt — friend's "3 strikes" discipline rule.
  // Walks today's closed trades and blocks new entries when N losses
  // fired in a row. Open positions continue. Resets at next UTC day.
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
        },
      });
      return { opened: 0 };
    }
  }

  // Data-driven time-of-day filter. Reads this algorithm's own per-hour
  // WR distribution; refuses entries during hours that historically
  // underperform. No-op when the filter is off OR when the current
  // hour bucket lacks samples (warm-up period for new algorithms).
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
      return { opened: 0 };
    }
  }

  // FTMO consistency-rule guard. Refuses new entries on a day whose
  // net profit already accounts for ≥ X% of total accumulated profit
  // (FTMO's standard challenge: 40%; funded plans: 50%). Stops a
  // single big day from disqualifying the whole evaluation.
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
      return { opened: 0 };
    }
  }

  // Resolve the active side for this ticker. Auto-side reads D1 bias and
  // returns null when neutral — skip the entry rather than force a guess.
  // Prefer the dedicated daily series when caller supplies one; resampling
  // an intraday compact series usually yields too few D1 bars for the bias
  // detector's 20-period MA, producing a misleading "neutral" verdict.
  const higherTfBars = dailyBars ?? resampleToDaily(bars);
  const resolved = resolveSide(rules.side ?? "long", higherTfBars);
  if (resolved === null) {
    const reason =
      higherTfBars.length < 20
        ? `Auto-side: insufficient D1 history (${higherTfBars.length} bars, need 20)`
        : "Auto-side: D1 bias is neutral";
    await logActivity(supabase, userId, {
      algorithm_id: algo.id,
      event_type: "signal_no_action",
      ticker,
      details: { reason },
    });
    return { opened: 0 };
  }

  const conflict = await checkDirectionConflict(
    supabase,
    userId,
    algo.id,
    ticker,
    resolved.side
  );
  if (conflict.block) {
    await logActivity(supabase, userId, {
      algorithm_id: algo.id,
      event_type: "signal_no_action",
      ticker,
      details: {
        reason: conflict.reason,
        proposed_side: resolved.side,
        conflicting_algorithm_ids: conflict.conflicting_algorithm_ids,
      },
    });
    return { opened: 0 };
  }

  // DXY directional filter. Opt-in per algo via rules.dxy_filter.
  // Refuses entries whose direction contradicts the dollar-index
  // direction over the configured lookback. EUR/USD bars are fetched
  // once per scan in scanAlgorithm and threaded through; null bars
  // means the filter is off OR the fetch failed (treated as no-op).
  if (rules.dxy_filter?.enabled && dxyBars && dxyBars.length > 0) {
    const dxy = checkDxyDirection({
      side: resolved.side,
      currentTimestamp: bars[bars.length - 1].date,
      proxyBars: dxyBars,
      config: rules.dxy_filter,
    });
    if (dxy.block) {
      await logActivity(supabase, userId, {
        algorithm_id: algo.id,
        event_type: "signal_no_action",
        ticker,
        details: {
          reason: dxy.reason ?? "DXY filter blocked",
          proposed_side: resolved.side,
          dxy_status: dxy.status,
          dxy_delta_pips: dxy.delta_pips,
          dxy_threshold_pips: dxy.threshold_pips,
          dxy_lookback_hours: dxy.lookback_hours,
        },
      });
      return { opened: 0 };
    }
  }

  // Regime/volatility gate. Same module the backtest uses, so live and
  // replay agree on whether a given moment is "tradeable". The check
  // runs against the daily series so the percentile is stable across
  // primary-timeframe choices (1h vs 15m won't change the verdict).
  if (rules.regime_filter?.enabled) {
    const regime = isRangingByAtr(higherTfBars, higherTfBars.length - 1, rules.regime_filter);
    if (regime.skip) {
      await logActivity(supabase, userId, {
        algorithm_id: algo.id,
        event_type: "signal_no_action",
        ticker,
        details: { reason: `Regime filter: ${regime.reason}` },
      });
      return { opened: 0 };
    }
  }

  // ADX trend-strength gate — skips entries during ranging tape.
  if (rules.adx_filter?.enabled) {
    const adx = isWeakTrendByAdx(higherTfBars, higherTfBars.length - 1, rules.adx_filter);
    if (adx.skip) {
      await logActivity(supabase, userId, {
        algorithm_id: algo.id,
        event_type: "signal_no_action",
        ticker,
        details: { reason: `ADX filter: ${adx.reason}` },
      });
      return { opened: 0 };
    }
  }

  const normalizedEntry = normalize(rules.entry_conditions);
  const evaluableEntry = normalizedEntry.filter(
    (c) => isTechnicalCondition(c) || isPatternCondition(c)
  ) as Array<TechnicalCondition | PatternCondition>;
  const conditionsResult = await checkEntryConditions(
    supabase,
    userId,
    algo.id,
    ticker,
    evaluableEntry,
    bars,
    closes,
    rules.timeframe,
    rules.entry_logic,
    resolved.directionOverride,
    higherTfBars
  );
  if (!conditionsResult.pass) return { opened: 0 };
  const convictionMult = pickConvictionMultiplier(rules, conditionsResult);

  const sentimentEntry = normalizedEntry.filter(isSentimentCondition);
  let sentimentResult: SignalResult | undefined;
  if (sentimentEntry.length > 0) {
    sentimentResult = await evaluateLiveSignal(rules, ticker, algo.description);
    if (sentimentResult.signal !== "buy") {
      await logActivity(supabase, userId, {
        algorithm_id: algo.id,
        event_type: "signal_no_action",
        ticker,
        details: {
          reason: "Sentiment conditions not met",
          signal: sentimentResult.signal,
          confidence: sentimentResult.confidence,
        },
      });
      return { opened: 0 };
    }
  }

  // Live broker spread gate — runs ONLY when there's a broker context
  // (i.e. live trading). Refuses entries when the current bid/ask gap
  // is wider than catalog typical × multiplier (currently 2.5x). Paper-
  // only mode skips this gate by definition (no broker = no quote).
  // Adapters that can't quote (cTrader streaming-only) return "skipped"
  // and we proceed without the refinement.
  let spread: SpreadGateResult | null = null;
  if (brokerCtx) {
    spread = await checkBrokerSpread(brokerCtx.adapter, brokerCtx.conn, ticker);
    if (spread.block) {
      await logActivity(supabase, userId, {
        algorithm_id: algo.id,
        event_type: "signal_no_action",
        ticker,
        details: {
          reason: spread.reason ?? "Live spread gate triggered",
          observed_spread_pips: spread.observed_spread_pips,
          threshold_pips: spread.threshold_pips,
          typical_pips: spread.typical_pips,
          bid: spread.bid,
          ask: spread.ask,
        },
      });
      return { opened: 0 };
    }
  }

  // Capped path: the strategy's full gate ladder passed and conditions
  // matched, but max_positions / max_per_ticker is full. Log a near-miss
  // (instead of signal_detected + openPosition) so the considered feed
  // shows the entry was viable. Without this branch the cap silently
  // dropped these — leaving the operator blind during slot-full windows.
  if (cappedReason) {
    await logActivity(supabase, userId, {
      algorithm_id: algo.id,
      event_type: "signal_no_action",
      ticker,
      details: {
        reason: cappedReason,
        conditions_met: conditionsResult.met,
        conditions_total: conditionsResult.total,
        conditions_breakdown: conditionsResult.fired,
        sentiment_signal: sentimentResult?.signal,
        sentiment_confidence: sentimentResult?.confidence,
        observed_spread_pips: spread?.observed_spread_pips,
        spread_status: spread?.status,
        atr_current: liquidity.atr_current,
        atr_threshold: liquidity.atr_threshold,
        would_have_entered: true,
      },
    });
    return { opened: 0 };
  }

  await logActivity(supabase, userId, {
    algorithm_id: algo.id,
    event_type: "signal_detected",
    ticker,
    details: {
      conditions_met: conditionsResult.met,
      conditions_total: conditionsResult.total,
      conditions_breakdown: conditionsResult.fired,
      sentiment_signal: sentimentResult?.signal,
      sentiment_confidence: sentimentResult?.confidence,
      // Spread telemetry on every allowed entry too — gives us the
      // distribution needed to switch from catalog × 2.5 to a learned
      // per-symbol p90 once we have enough samples.
      observed_spread_pips: spread?.observed_spread_pips,
      spread_status: spread?.status,
      atr_current: liquidity.atr_current,
      atr_threshold: liquidity.atr_threshold,
    },
  });

  return openPosition(
    supabase,
    userId,
    algo,
    ticker,
    currentPrice,
    evaluableEntry,
    sentimentResult,
    allOpenPositions,
    brokerCtx ?? null,
    convictionMult,
    bars
  );
}

/**
 * LLM-trader entry path — siblings of evaluateEntry. Replaces the
 * pattern-detect + threshold pipeline (entry_conditions check + sentiment)
 * with an LLM call that determines direction (long/short/hold/exit)
 * from rich market context.
 *
 * Defensive pre-gates that still apply on top: intraday ATR liquidity,
 * news veto, R-aware consec-loss halt, time-of-day filter (if enabled),
 * FTMO consistency halt (live), broker spread gate (live), position-size
 * sanity gate (in openPosition).
 *
 * Strategy-specific filters skipped: dxy_filter, regime_filter, adx_filter
 * — the LLM already considers DXY / regime / trend in its prompt context,
 * applying the gates would be double-counting. The user can re-enable
 * via rules if they want stricter behaviour.
 */
async function evaluateLlmTraderEntry(
  supabase: SupabaseClient,
  userId: string,
  algo: AlgoContext,
  ticker: string,
  bars: PriceBar[],
  closes: number[],
  allOpenPositions: PaperPosition[],
  livePrice?: number | null,
  brokerCtx?: BrokerExecutionContext | null,
  dailyBars?: PriceBar[] | null,
  dxyBars?: PriceBar[] | null,
  intermarket?: {
    silver?: PriceBar[];
    yield10y?: PriceBar[];
    vix?: PriceBar[];
  } | null,
  cappedReason?: string | null,
  force = false
): Promise<{ opened: number; openEvent?: PositionEvent }> {
  const rules = algo.rules;
  const llmConfig = rules.llm_trader;
  if (!llmConfig?.enabled) return { opened: 0 };
  const currentPrice = livePrice ?? closes[closes.length - 1];

  // Bar-close gate: only call the LLM at primary-TF bar-close moments.
  // The scan-cron fires every 15 min but mid-bar calls would feed the
  // LLM partial-bar context, diverging from how the backtest evaluated.
  // For 4h algos this means the LLM fires ~6 times/day (00/04/08/12/16/20
  // UTC); intermediate scan ticks silently skip.
  //
  // Operator-triggered "Scan now" passes force=true to bypass — the
  // explicit click is the operator asking for a snapshot evaluation
  // even mid-bar; the silent-skip behaviour was confusing on the UI.
  // The bar-close gate applies to BOTH entry and management scans —
  // mid-bar context is bad regardless of position state.
  if (!force && !isBarCloseScan(rules.timeframe)) {
    return { opened: 0 };
  }

  // Bar-staleness gate — refuse the LLM call entirely when the most
  // recent bar is more than 1.5× the primary TF old. Catches the
  // root cause behind the 2026-05-12 Trade #3 incident: the 30m
  // price cache hadn't refreshed for ~60 min, so the LLM analyzed
  // bars dated 00:30 at 01:30 UTC decision time, $25 below live
  // price. Save the API spend AND don't manage an open position on
  // stale data — both paths benefit from refusal here.
  const lastBarDate = bars.length > 0 ? bars[bars.length - 1].date : null;
  const staleness = checkBarStaleness({
    timeframe: rules.timeframe,
    lastBarDate,
  });
  if (staleness.block) {
    await logActivity(supabase, userId, {
      algorithm_id: algo.id,
      event_type: "signal_no_action",
      ticker,
      details: {
        reason: staleness.reason ?? "Bar-staleness gate triggered",
        source: "llm_trader",
        bar_age_minutes: staleness.bar_age_minutes,
        threshold_minutes: staleness.threshold_minutes,
        last_bar_date: staleness.last_bar_date,
      },
    });
    return { opened: 0 };
  }

  // Load the position FIRST so the entry-side gates below can be
  // conditionally skipped when a position is open. The entry-side
  // gates (dead-hour, ATR liquidity, news veto, consec halt, consistency
  // halt) all exist to REFUSE NEW ENTRIES in unfavourable conditions.
  // They were previously running unconditionally, which silently muzzled
  // the LLM's ability to manage existing positions during exactly the
  // periods where management matters most (post-weekend gap dead-vol,
  // pre-news drift, London close).
  //
  // Incident 2026-05-11: 4h XAU/USD long hit a $365 SL after the ATR
  // gate skipped 3 consecutive LLM calls across the Sunday-open →
  // Monday-pre-dump window (ATR 22.18, 16.32, 17.33 — all below 20th
  // percentile). The model never got the chance to evaluate exit /
  // move_be before the structural stop fired at 05:46 UTC.
  //
  // Fix: gates only block when there's no open position. When in trade,
  // the LLM is always called so it can hold / exit / move_be. The gates
  // still log signal_no_action so the audit trail is preserved.
  const currentPosition =
    allOpenPositions.find((p) => p.algorithm_id === algo.id && p.ticker === ticker) ?? null;

  // ATR liquidity is computed unconditionally so its values can be
  // surfaced in the signal_detected log later. The skip/refuse behaviour
  // only applies when there's no open position (entry-side gate).
  const liquidity = checkAtrLiquidity(bars, bars.length - 1);

  if (!currentPosition) {
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
      return { opened: 0 };
    }

    // ---- Defensive pre-gates (mirror evaluateEntry) ----

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
      return { opened: 0 };
    }

    const veto = await checkNewsVeto(rules, ticker);
    if (veto.vetoed) {
      await logActivity(supabase, userId, {
        algorithm_id: algo.id,
        event_type: "signal_no_action",
        ticker,
        details: { reason: `News veto: ${veto.reason}`, source: "llm_trader" },
      });
      return { opened: 0 };
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
        return { opened: 0 };
      }
    }

    // Re-entry cooldown — refuses a new entry on this (algo, ticker)
    // when a loss closed within the last primary-TF bar. Closes the
    // race where the just-stopped trade hasn't yet incremented the
    // consec-loss halt's count. See re-entry-cooldown.ts for incident
    // context (2026-05-12 Trade #3 fired 19s after Trade #1 stopped).
    const cooldown = await checkReEntryCooldown({
      supabase,
      algorithmId: algo.id,
      ticker,
      timeframe: rules.timeframe,
    });
    if (cooldown.block) {
      await logActivity(supabase, userId, {
        algorithm_id: algo.id,
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
      return { opened: 0 };
    }

    const consistencyPct = rules.prop_firm?.consistency_rule ?? 0;
    if (consistencyPct > 0 && brokerCtx) {
      const halt = await checkConsistencyHalt(supabase, algo.id, consistencyPct);
      if (halt.tripped) {
        await logActivity(supabase, userId, {
          algorithm_id: algo.id,
          event_type: "signal_no_action",
          ticker,
          details: {
            reason: `Consistency halt: today $${halt.today_net.toFixed(0)} = ${(halt.ratio * 100).toFixed(1)}% of total $${halt.total_net.toFixed(0)} (≥ ${(halt.threshold * 100).toFixed(0)}% limit)`,
            source: "llm_trader",
          },
        });
        return { opened: 0 };
      }
    }
  }

  // ---- LLM call ----
  // currentPosition was loaded above (before the entry-side gates).
  // Layer 3 in-context reflection — pass the algo's recent track record
  // into the LLM context. Self-gates: returns null when <10 closed trades
  // exist, so it's silently omitted during the warm-up phase. Activates
  // automatically as trades accumulate.
  const recentOutcomes = await summariseRecentOutcomes(supabase, algo.id);
  // v5 + v5_15m + v2_mtf prompts require multi-TF structural context. We
  // resample the in-memory primary bars to one or two higher TFs on the
  // fly so the LLM sees structure independently of D1's lagging 14-day
  // window. Caller emits the line only when the prompt version opts in.
  // Pairings:
  //   30m primary → 1h + 4h (v5)
  //   15m primary → 30m + 1h (v5_15m)
  //   4h primary  → 1h only (v2_mtf — gives faster-pulse early-warning vs D1 lag)
  //   1h primary  → 4h only (single higher TF — override rule degraded)
  const useMultiTf =
    llmConfig.prompt_version === "v5" ||
    llmConfig.prompt_version === "v5_15m" ||
    llmConfig.prompt_version === "v2_mtf";
  const higherTfBars = useMultiTf
    ? rules.timeframe === "30m"
      ? [
          { tfLabel: "1h", bars: resampleTo(bars, "1h") },
          { tfLabel: "4h", bars: resampleTo(bars, "4h") },
        ]
      : rules.timeframe === "15m"
        ? [
            { tfLabel: "30m", bars: resampleTo(bars, "30min") },
            { tfLabel: "1h", bars: resampleTo(bars, "1h") },
          ]
        : rules.timeframe === "4h"
          ? [{ tfLabel: "1h", bars: resampleTo(bars, "1h") }]
          : rules.timeframe === "1h"
            ? [{ tfLabel: "4h", bars: resampleTo(bars, "4h") }]
            : []
    : undefined;

  const ctx: LlmTraderContext = {
    currentTimestamp: bars[bars.length - 1].date,
    bars,
    dailyBars: dailyBars ?? [],
    dxyBars,
    intermarket: intermarket ?? undefined,
    position: currentPosition
      ? {
          side: currentPosition.side,
          entryPrice: Number(currentPosition.entry_price),
          entryDate: currentPosition.opened_at,
          stopPrice: currentPosition.stop_loss_price
            ? Number(currentPosition.stop_loss_price)
            : undefined,
          initialStopPrice: currentPosition.initial_stop_loss_price
            ? Number(currentPosition.initial_stop_loss_price)
            : undefined,
          targetPrice: currentPosition.take_profit_price
            ? Number(currentPosition.take_profit_price)
            : undefined,
        }
      : null,
    timeframe: rules.timeframe,
    recentOutcomes,
    higherTfBars,
  };
  const evaluation = await evaluateLlmTrader(llmConfig, ctx);
  const decision = evaluation.decision;
  if (!decision) {
    await logActivity(supabase, userId, {
      algorithm_id: algo.id,
      event_type: "signal_no_action",
      ticker,
      details: {
        reason: "LLM call failed (after retry)",
        source: "llm_trader",
        regime: evaluation.regime,
      },
    });
    return { opened: 0 };
  }

  // Audit-log the decision (best-effort; never blocks trade flow). For
  // entry decisions, paper_position_id is linked back after openPosition
  // succeeds. For hold/exit, the row stays unlinked.
  const hadPosition: "flat" | "long" | "short" =
    currentPosition ? (currentPosition.side as "long" | "short") : "flat";
  const decisionId = await recordLlmDecision(supabase, {
    algorithmId: algo.id,
    userId,
    barDate: ctx.currentTimestamp,
    evaluation,
    hadPosition,
    source: "live",
  });

  // ---- Decision dispatch ----

  // Hold: always log. Earlier this was gated on !cappedReason on the
  // assumption that the cap path would log instead — but the cap path
  // only fires on enter_long/enter_short (line ~1491), so when the LLM
  // said "hold" while in trade (cappedReason set because max_positions=1)
  // the tick was silently dropped. Operator lost visibility of every
  // in-trade management decision unless they queried llm_decisions
  // directly. 2026-05-12: surfaced when a short held through its own
  // entry premise evaporating, with no signal in the UI.
  if (decision.decision === "hold") {
    await logActivity(supabase, userId, {
      algorithm_id: algo.id,
      ...(currentPosition ? { position_id: currentPosition.id } : {}),
      event_type: "signal_no_action",
      ticker,
      details: {
        reason: "LLM decision: hold",
        source: "llm_trader",
        regime: evaluation.regime,
        confidence: decision.confidence,
        llm_reasoning: decision.reasoning,
        had_position: hadPosition,
      },
    });
    return { opened: 0 };
  }

  // Move-to-break-even: LLM-judged decision (v4+ prompts only) that
  // locks in profit by moving SL to entry price. Only valid when in a
  // profitable position with current P&L >= +1R favorable. The trade
  // continues; broker's wider SL stays as safety net. Manage tick will
  // close the position when our (now-tighter) SL is hit, OR LLM may
  // emit "exit" later, OR TP fires.
  if (decision.decision === "move_be") {
    if (!currentPosition) {
      await logActivity(supabase, userId, {
        algorithm_id: algo.id,
        event_type: "signal_no_action",
        ticker,
        details: {
          reason: "LLM decision: move_be but no open position",
          source: "llm_trader",
          regime: evaluation.regime,
          confidence: decision.confidence,
          llm_reasoning: decision.reasoning,
        },
      });
      return { opened: 0 };
    }
    const entryPrice = Number(currentPosition.entry_price);
    const stopPrice = currentPosition.stop_loss_price
      ? Number(currentPosition.stop_loss_price)
      : null;
    if (!stopPrice) {
      await logActivity(supabase, userId, {
        algorithm_id: algo.id,
        position_id: currentPosition.id,
        event_type: "signal_no_action",
        ticker,
        details: {
          reason: "LLM decision: move_be but no stop_loss_price set on position",
          source: "llm_trader",
          regime: evaluation.regime,
          confidence: decision.confidence,
          llm_reasoning: decision.reasoning,
        },
      });
      return { opened: 0 };
    }
    // Use initial SL distance for the +1R gate so a second move_be on the
    // same trade doesn't divide by zero (after the first BE move,
    // stop_loss_price == entry_price). Falls back to current SL for
    // legacy rows opened before migration 00032.
    const initialStop = currentPosition.initial_stop_loss_price ?? stopPrice;
    const slDistance = Math.abs(entryPrice - Number(initialStop));
    const currentPnlR =
      currentPosition.side === "long"
        ? (currentPrice - entryPrice) / slDistance
        : (entryPrice - currentPrice) / slDistance;
    if (currentPnlR < 1.0) {
      // LLM tried to move BE without being at +1R favorable. Defensive:
      // log + ignore. Don't trust LLM's pnl estimate; verify against
      // actual price.
      await logActivity(supabase, userId, {
        algorithm_id: algo.id,
        position_id: currentPosition.id,
        event_type: "signal_no_action",
        ticker,
        details: {
          reason: `LLM decision: move_be but only +${currentPnlR.toFixed(2)}R favorable (need +1R)`,
          source: "llm_trader",
          regime: evaluation.regime,
          confidence: decision.confidence,
          llm_reasoning: decision.reasoning,
        },
      });
      return { opened: 0 };
    }
    // Update SL to entry price. Broker's wider SL stays as safety net;
    // our tighter logical SL gets caught by manage tick when price
    // crosses.
    await supabase
      .from("paper_positions")
      .update({ stop_loss_price: entryPrice })
      .eq("id", currentPosition.id);
    await logActivity(supabase, userId, {
      algorithm_id: algo.id,
      position_id: currentPosition.id,
      event_type: "signal_no_action",
      ticker,
      details: {
        reason: `LLM moved SL to break-even at +${currentPnlR.toFixed(2)}R`,
        source: "llm_trader",
        regime: evaluation.regime,
        action: "move_sl_to_be",
        old_stop_loss: stopPrice,
        new_stop_loss: entryPrice,
        current_pnl_r: currentPnlR,
        confidence: decision.confidence,
        llm_reasoning: decision.reasoning,
      },
    });
    return { opened: 0 };
  }

  // Exit: close the position at this bar's close. Mirrors backtest
  // behaviour — the LLM's "exit" decision is a regime-flip / thesis-
  // breakdown signal that's the algo's edge for catching turns before
  // SL fires. Without this branch, "exit" was a logged no-op and
  // positions ran to SL/TP, costing an estimated $1-3K per 8mo window
  // on the regime-flip cohort. (Previously TODO'd to manage tick;
  // simpler to action here where we already have currentPosition.)
  if (decision.decision === "exit") {
    if (!currentPosition) {
      // LLM said exit but we're flat — no-op + log. Shouldn't happen
      // (the prompt instructs "exit only valid when in a position")
      // but defensive.
      await logActivity(supabase, userId, {
        algorithm_id: algo.id,
        event_type: "signal_no_action",
        ticker,
        details: {
          reason: "LLM decision: exit but no open position",
          source: "llm_trader",
          regime: evaluation.regime,
          confidence: decision.confidence,
          llm_reasoning: decision.reasoning,
        },
      });
      return { opened: 0 };
    }
    const exitPrice = currentPrice;
    const realizedPnl = pnlInUsd(
      ticker,
      currentPosition.side as "long" | "short",
      Number(currentPosition.entry_price),
      exitPrice,
      Number(currentPosition.quantity)
    );
    await supabase
      .from("paper_positions")
      .update({
        current_price: exitPrice,
        exit_price: exitPrice,
        unrealized_pnl: 0,
        realized_pnl: realizedPnl,
        exit_reason: "exit_signal",
        status: "closed",
        closed_at: new Date().toISOString(),
      })
      .eq("id", currentPosition.id);
    if (brokerCtx) {
      await executeLiveExit({
        supabase,
        userId,
        algorithmId: algo.id,
        paperPositionId: currentPosition.id,
        ticker,
        brokerPositionId: currentPosition.broker_position_id ?? null,
        closePrice: exitPrice,
        ctx: brokerCtx,
      });
    }
    await logActivity(supabase, userId, {
      algorithm_id: algo.id,
      position_id: currentPosition.id,
      event_type: "position_closed",
      ticker,
      details: {
        reason: "LLM decision: exit",
        source: "llm_trader",
        regime: evaluation.regime,
        exit_price: exitPrice,
        realized_pnl: realizedPnl,
        exit_reason: "exit_signal",
        confidence: decision.confidence,
        llm_reasoning: decision.reasoning,
      },
    });
    return { opened: 0 };
  }

  // enter_long / enter_short
  const llmSide: "long" | "short" =
    decision.decision === "enter_long" ? "long" : "short";

  // RANGING regime block — applies only to prompt versions WITHOUT
  // multi-TF override logic (v1-v4). Empirical finding for v3 specifically
  // (beyr1223h 30d): RANGING entries went 0/4, -$2,217 cumulative, 0% WR.
  // v3 has a soft "RANGING block" rule the LLM doesn't reliably follow,
  // so we hard-block at the gate level for v1-v4.
  //
  // v5 + v5_15m prompts DO have explicit multi-TF override logic — they
  // can override a D1 RANGING regime when 30m+1h (v5) or 30m+1h (v5_15m)
  // both agree on direction. Hard-blocking those prompts defeats the
  // whole design of the override. Trust the LLM's nuanced regime read
  // when it has the multi-TF data to make it.
  //
  // Incident 2026-05-11: 15m (v5_15m) + 30m (v5) both correctly called
  // MULTI-TF OVERRIDE long at 12:15 UTC (D1=RANGING, 30m=HH, 1h=HH,
  // +0.71% momentum) — both blocked by this gate. The LLM was right;
  // the gate was applying v3 calibration to prompts that have moved on.
  //
  // Schema note: prompt_version defaults to v2 when unset
  // (DEFAULT_PROMPT_VERSION in llm-trader-prompts.ts). Undefined treated
  // as legacy (block applies).
  const hasMultiTfOverride =
    llmConfig.prompt_version === "v5" || llmConfig.prompt_version === "v5_15m";
  if (evaluation.regime === "RANGING" && !hasMultiTfOverride) {
    await logActivity(supabase, userId, {
      algorithm_id: algo.id,
      event_type: "signal_no_action",
      ticker,
      details: {
        reason: `RANGING regime block: 0/4 historical WR (-$2,217 in beyr1223h 30d). Chop regime has structurally negative EV for ${llmConfig.prompt_version ?? "legacy"} prompt — hold and wait for regime shift.`,
        source: "llm_trader",
        regime: evaluation.regime,
        confidence: decision.confidence,
        llm_reasoning: decision.reasoning,
        would_have_entered_side: llmSide,
      },
    });
    return { opened: 0 };
  }

  // Cohort gates removed (#136 LH-short upper-range, #137 HH-long lower-range)
  // 2026-05-06. Both were calibrated against beyr1223h Apr 2026 data — a
  // single chop-window sample. Risk analysis showed they could
  // systematically block winners in trending markets:
  //
  //  - HH-long lower-range gate refuses entries >0.30% above 20-bar low.
  //    In a sustained uptrend, price is ALWAYS >0.30% above old lows
  //    (the trend keeps making new highs). Gate would fire on virtually
  //    every HH-long entry, blocking the entire trend-following cohort.
  //
  //  - LH-short upper-range gate similarly risked blocking valid fade
  //    entries during sustained downtrends with strong rallies.
  //
  // Architecture decision: structural-failure gates (RANGING block #140,
  // consec-halt #138, adaptive TP #139) stay — those are regime-neutral
  // protections. Cohort-judgment is returned to the LLM, which already
  // has the same data (regime, range position, momentum) in its context.
  //
  // Phase 2 path (when ≥20-30 live trades accumulate): activate Layer 3
  // cohort breakdown via summariseRecentOutcomes — surface "your last 10
  // HH-long entries far from low went X/Y" so the LLM can weigh the
  // historical signal as data, not as a hard block.

  // Capped: log near-miss with LLM reasoning, don't open
  if (cappedReason) {
    await logActivity(supabase, userId, {
      algorithm_id: algo.id,
      event_type: "signal_no_action",
      ticker,
      details: {
        reason: cappedReason,
        source: "llm_trader",
        regime: evaluation.regime,
        would_have_entered_side: llmSide,
        confidence: decision.confidence,
        llm_reasoning: decision.reasoning,
        would_have_entered: true,
      },
    });
    return { opened: 0 };
  }

  // Dry-run: log but don't open
  if (llmConfig.dry_run) {
    await logActivity(supabase, userId, {
      algorithm_id: algo.id,
      event_type: "signal_no_action",
      ticker,
      details: {
        reason: "dry_run mode — would have entered",
        source: "llm_trader",
        regime: evaluation.regime,
        would_have_entered_side: llmSide,
        confidence: decision.confidence,
        llm_reasoning: decision.reasoning,
      },
    });
    return { opened: 0 };
  }

  // Spread gate (live only)
  if (brokerCtx) {
    const spread = await checkBrokerSpread(brokerCtx.adapter, brokerCtx.conn, ticker);
    if (spread.block) {
      await logActivity(supabase, userId, {
        algorithm_id: algo.id,
        event_type: "signal_no_action",
        ticker,
        details: {
          reason: spread.reason ?? "Live spread gate triggered",
          source: "llm_trader",
          regime: evaluation.regime,
          observed_spread_pips: spread.observed_spread_pips,
          threshold_pips: spread.threshold_pips,
        },
      });
      return { opened: 0 };
    }
  }

  // Live-price drift gate — refuse when the broker's live quote has
  // moved beyond threshold from the bar-close the LLM analyzed, in
  // either direction. The LLM reasons about a snapshot of the last
  // completed bar; if the unprinted current bar has moved >0.20% in
  // either direction, the setup the LLM described no longer exists
  // at the actual fill price. See live-price-drift-gate.ts for the
  // 2026-05-12 incident that motivated this gate (top-tick on adverse
  // drift) and the absolute-drift revision (falling-knife re-entry).
  const barCloseForDrift = closes[closes.length - 1];
  const drift = checkLivePriceDrift({
    side: llmSide,
    barClose: barCloseForDrift,
    livePrice,
  });
  if (drift.block) {
    await logActivity(supabase, userId, {
      algorithm_id: algo.id,
      event_type: "signal_no_action",
      ticker,
      details: {
        reason: drift.reason ?? "Live-price drift gate triggered",
        source: "llm_trader",
        regime: evaluation.regime,
        would_have_entered_side: llmSide,
        confidence: decision.confidence,
        llm_reasoning: decision.reasoning,
        bar_close: drift.bar_close,
        live_price: drift.live_price,
        drift_pct: drift.drift_pct,
        drift_abs_pct: drift.drift_abs_pct,
        threshold_pct: drift.threshold_pct,
      },
    });
    return { opened: 0 };
  }

  // Log the decision as a real signal_detected with full LLM trace
  await logActivity(supabase, userId, {
    algorithm_id: algo.id,
    event_type: "signal_detected",
    ticker,
    details: {
      source: "llm_trader",
      regime: evaluation.regime,
      direction: llmSide,
      confidence: decision.confidence,
      llm_reasoning: decision.reasoning,
      atr_current: liquidity.atr_current,
      atr_threshold: liquidity.atr_threshold,
    },
  });

  // Open with LLM-determined side. We override rules.side temporarily so
  // openPosition's side resolution picks up the LLM's call. Other fields
  // unchanged — sizing, SL/TP, sanity gates all run as normal.
  //
  // Adaptive TP context: pass D1-derived regime + daily ATR so TP
  // computation can tighten the rule-based RR/percentage in chop and
  // cap absolute distance at a reachable fraction of recent daily
  // volatility. See AdaptiveTpContext docstring for details.
  const algoForOpen: AlgoContext = {
    ...algo,
    rules: { ...algo.rules, side: llmSide },
  };
  const adaptiveTpCtx: AdaptiveTpContext = {
    regime: evaluation.regime,
    dailyAtr: dailyBars && dailyBars.length > 0 ? dailyAtrFromBars(dailyBars) : 0,
  };
  const opened = await openPosition(
    supabase,
    userId,
    algoForOpen,
    ticker,
    currentPrice,
    [],
    undefined,
    allOpenPositions,
    brokerCtx ?? null,
    1,
    bars,
    adaptiveTpCtx
  );
  // Link the decision row to the resulting paper_positions row so the
  // close path can backfill the trade outcome onto this decision.
  if (decisionId && opened.paperPositionId) {
    await linkLlmDecisionToPosition(supabase, decisionId, opened.paperPositionId);
  }
  return opened;
}
