/**
 * Entry evaluation — checks if conditions are met and opens a new position.
 */
import { checkConditions, normalize, type Cache } from "@/lib/market-data/backtest-engine";
import {
  fetchEconomicCalendar,
  getEventCurrencies,
  isWithinVetoWindow,
} from "@/lib/market-data/economic-calendar";
import { evaluateLiveSignal, type SignalResult } from "@/lib/signals/evaluate-live";
import {
  isSentimentCondition,
  isTechnicalCondition,
  type AlgorithmRules,
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

async function openPosition(
  supabase: SupabaseClient,
  userId: string,
  algo: AlgoContext,
  ticker: string,
  currentPrice: number,
  techEntry: TechnicalCondition[],
  sentimentResult: SignalResult | undefined,
  allOpenPositions: PaperPosition[],
  brokerCtx: BrokerExecutionContext | null
): Promise<{ opened: number; openEvent?: PositionEvent }> {
  const openValue = allOpenPositions.reduce((sum, p) => sum + p.notional_value, 0);
  const sizing = calculatePositionSize(algo.rules, algo.capital, openValue, currentPrice, ticker);
  if (!sizing) {
    return { opened: 0 };
  }

  const side = "long" as const;
  const { stopLossPrice, takeProfitPrice } = calculateRiskPrices(currentPrice, algo.rules, side);
  const entryReason = {
    conditions_met: techEntry.map((c) => ({
      type: c.type,
      indicator: c.indicator,
      operator: c.operator,
      value: c.value,
    })),
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
  const lotSizing = algo.rules.position_sizing.type === "lots"
    ? algo.rules.position_sizing.value
    : undefined;
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

export async function evaluateEntry(
  supabase: SupabaseClient,
  userId: string,
  algo: AlgoContext,
  ticker: string,
  closes: number[],
  allOpenPositions: PaperPosition[],
  livePrice?: number | null,
  brokerCtx?: BrokerExecutionContext | null
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

  const normalizedEntry = normalize(rules.entry_conditions);
  const techEntry = normalizedEntry.filter(isTechnicalCondition) as TechnicalCondition[];
  if (techEntry.length > 0) {
    const cache: Cache = new Map();
    if (!checkConditions(techEntry, cache, closes, closes.length - 1, rules.entry_logic)) {
      await logActivity(supabase, userId, {
        algorithm_id: algo.id,
        event_type: "signal_no_action",
        ticker,
        details: { reason: "Technical conditions not met" },
      });
      return { opened: 0 };
    }
  }

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
      technical_conditions_met: techEntry.length,
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
    techEntry,
    sentimentResult,
    allOpenPositions,
    brokerCtx ?? null
  );
}
