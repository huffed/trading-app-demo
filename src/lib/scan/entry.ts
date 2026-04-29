/**
 * Entry evaluation — checks if conditions are met and opens a new position.
 */
import {
  convictionMultiplier,
  convictionMultiplierByTfAgreement,
} from "@/lib/algorithm/conviction-sizing";
import { checkAtrLiquidity } from "@/lib/algorithm/intraday-atr-gate";
import { checkBrokerSpread, type SpreadGateResult } from "@/lib/algorithm/spread-gate";
import { checkTimeOfDayFilter } from "@/lib/algorithm/time-of-day-filter";
import { getContractSize } from "@/lib/constants/markets";
import { isWeakTrendByAdx } from "@/lib/market-data/adx-filter";
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
import { executeLiveEntry, type BrokerExecutionContext } from "./live-execution";
import { getPerHourStats } from "./per-hour-stats";
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
  convictionMult: number = 1
): Promise<{ opened: number; openEvent?: PositionEvent }> {
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
  const sizing = calculatePositionSize(
    algo.rules,
    algo.capital,
    openValue,
    currentPrice,
    ticker,
    convictionMult
  );
  if (!sizing) {
    return { opened: 0 };
  }

  // Side is resolved by the caller (evaluateEntry) — at this point it's
  // a concrete long/short, never "auto". Default to long for legacy callers.
  const side: "long" | "short" =
    algo.rules.side === "long" || algo.rules.side === "short"
      ? algo.rules.side
      : "long";
  const { stopLossPrice, takeProfitPrice } = calculateRiskPrices(
    currentPrice,
    algo.rules,
    side,
    ticker
  );
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
  dailyBars?: PriceBar[] | null
): Promise<{ opened: number; openEvent?: PositionEvent }> {
  const rules = algo.rules;
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
    convictionMult
  );
}
