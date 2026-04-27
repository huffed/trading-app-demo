/**
 * Entry evaluation — checks if conditions are met and opens a new position.
 */
import { getContractSize } from "@/lib/constants/markets";
import { resolveSide } from "@/lib/market-data/auto-side";
import {
  checkConditions,
  collectOtherTimeframes,
  normalize,
  type Cache,
} from "@/lib/market-data/backtest-engine";
import type { BarsBundle } from "@/lib/market-data/condition-evaluator";
import {
  fetchEconomicCalendar,
  getEventCurrencies,
  isWithinVetoWindow,
} from "@/lib/market-data/economic-calendar";
import { resampleTo, resampleToDaily } from "@/lib/market-data/resample";
import type { PriceBar } from "@/lib/market-data/types";
import { evaluateLiveSignal, type SignalResult } from "@/lib/signals/evaluate-live";
import {
  isPatternCondition,
  isSentimentCondition,
  isTechnicalCondition,
  type AlgorithmRules,
  type PatternCondition,
  type TechnicalCondition,
} from "@/types/algorithm";
import type { PaperPosition, PositionEvent } from "@/types/position";
import { calculatePositionSize, calculateRiskPrices, logActivity } from "./helpers";
import { executeLiveEntry, type BrokerExecutionContext } from "./live-execution";
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
  brokerCtx: BrokerExecutionContext | null
): Promise<{ opened: number; openEvent?: PositionEvent }> {
  // calculatePositionSize wants MARGIN-used summed, not notional. For
  // leveraged sizing (lots / risk_per_trade) sum notional / leverage so
  // 3 forex positions at 1:100 don't appear to consume the whole account.
  const sizing0 = algo.rules.position_sizing;
  const isLeveraged = sizing0.type === "lots" || sizing0.type === "risk_per_trade";
  const lev = algo.rules.leverage ?? 30;
  const openValue = allOpenPositions.reduce(
    (sum, p) => sum + (isLeveraged ? p.notional_value / lev : p.notional_value),
    0
  );
  const sizing = calculatePositionSize(algo.rules, algo.capital, openValue, currentPrice, ticker);
  if (!sizing) {
    return { opened: 0 };
  }

  // Side is resolved by the caller (evaluateEntry) — at this point it's
  // a concrete long/short, never "auto". Default to long for legacy callers.
  const side: "long" | "short" =
    algo.rules.side === "long" || algo.rules.side === "short"
      ? algo.rules.side
      : "long";
  const { stopLossPrice, takeProfitPrice } = calculateRiskPrices(currentPrice, algo.rules, side);
  const entryReason = {
    conditions_met: conditions.map(snapshotCondition),
    signal_result: sentimentResult
      ? {
          signal: sentimentResult.signal,
          confidence: sentimentResult.confidence,
          reasoning: sentimentResult.reasoning,
        }
      : undefined,
  };

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
  // value verbatim. For "risk_per_trade" we back-compute from the sized
  // quantity (which calculatePositionSize already produced via riskToLots).
  // Other sizing types don't map to a meaningful lot count → undefined.
  let lotSizing: number | undefined;
  if (algo.rules.position_sizing.type === "lots") {
    lotSizing = algo.rules.position_sizing.value;
  } else if (algo.rules.position_sizing.type === "risk_per_trade") {
    const contract = getContractSize(ticker, algo.rules.asset_class);
    lotSizing = contract > 0 ? sizing.quantity / contract : undefined;
  }
  await logOpenAndMirror({
    supabase,
    userId,
    algoId: algo.id,
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

/** Evaluate the entry-condition gate (technical + pattern) and log a
 *  signal_no_action event when it fails. Returns true to proceed, false
 *  to short-circuit. Sentiment is checked separately. */
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
): Promise<boolean> {
  if (conditions.length === 0) return true;
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
  if (checkConditions(conditions, ctx, logic)) return true;
  await logActivity(supabase, userId, {
    algorithm_id: algoId,
    event_type: "signal_no_action",
    ticker,
    details: { reason: "Entry conditions not met" },
  });
  return false;
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

  const normalizedEntry = normalize(rules.entry_conditions);
  const evaluableEntry = normalizedEntry.filter(
    (c) => isTechnicalCondition(c) || isPatternCondition(c)
  ) as Array<TechnicalCondition | PatternCondition>;
  const conditionsPass = await checkEntryConditions(
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
  if (!conditionsPass) return { opened: 0 };

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

  await logActivity(supabase, userId, {
    algorithm_id: algo.id,
    event_type: "signal_detected",
    ticker,
    details: {
      conditions_met: evaluableEntry.length,
      sentiment_signal: sentimentResult?.signal,
      sentiment_confidence: sentimentResult?.confidence,
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
    brokerCtx ?? null
  );
}
