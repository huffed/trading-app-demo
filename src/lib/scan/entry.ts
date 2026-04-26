/**
 * Entry evaluation — checks if conditions are met and opens a new position.
 */
import { checkConditions, normalize, type Cache } from "@/lib/market-data/backtest-engine";
import { evaluateLiveSignal, type SignalResult } from "@/lib/signals/evaluate-live";
import {
  isSentimentCondition,
  isTechnicalCondition,
  type AlgorithmRules,
  type TechnicalCondition,
} from "@/types/algorithm";
import type { PaperPosition, PositionEvent } from "@/types/position";
import { calculatePositionSize, calculateRiskPrices, logActivity } from "./helpers";
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
  allOpenPositions: PaperPosition[]
): Promise<{ opened: number; openEvent?: PositionEvent }> {
  const openValue = allOpenPositions.reduce((sum, p) => sum + p.notional_value, 0);
  const sizing = calculatePositionSize(algo.rules, algo.capital, openValue, currentPrice);
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

  if (position) {
    await logActivity(supabase, userId, {
      algorithm_id: algo.id,
      position_id: position.id,
      event_type: "position_opened",
      ticker,
      details: {
        entry_price: currentPrice,
        quantity: sizing.quantity,
        notional_value: sizing.notionalValue,
        stop_loss_price: stopLossPrice,
        take_profit_price: takeProfitPrice,
      },
    });
    return {
      opened: 1,
      openEvent: { ticker, reason: "entry_signal", pnl: 0, price: currentPrice },
    };
  }
  return { opened: 0 };
}

export async function evaluateEntry(
  supabase: SupabaseClient,
  userId: string,
  algo: AlgoContext,
  ticker: string,
  closes: number[],
  allOpenPositions: PaperPosition[],
  livePrice?: number | null
): Promise<{ opened: number; openEvent?: PositionEvent }> {
  const rules = algo.rules;
  // Use real-time price for entry, fall back to latest daily close
  const currentPrice = livePrice ?? closes[closes.length - 1];

  const normalizedEntry = normalize(rules.entry_conditions);
  const techEntry = normalizedEntry.filter(isTechnicalCondition) as TechnicalCondition[];
  if (techEntry.length > 0) {
    const cache: Cache = new Map();
    if (!checkConditions(techEntry, cache, closes, closes.length - 1)) {
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
    allOpenPositions
  );
}
