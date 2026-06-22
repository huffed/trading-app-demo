/**
 * Entry evaluation — orchestrator. The actual work lives in 4 siblings:
 *   - entry-conviction.ts → checkEntryConditions, pickConvictionMultiplier, snapshotCondition
 *   - entry-gates.ts      → checkDirectionConflict, checkNewsVeto, computeLiveMarketState
 *   - entry-open.ts       → openPosition + AlgoContext (the position-opening core)
 *   - entry-llm-trader.ts → evaluateLlmTraderEntry (LLM-trader path; very large)
 *
 * This file contains evaluateEntry — the deterministic-conditions path —
 * plus the dispatch to the LLM-trader path when rules.llm_trader.enabled.
 * The function is referenced by exactly one downstream importer
 * (scan/engine.ts), confirmed via grep at the CB.C1 split (2026-06-20).
 *
 * The EntryContext options-bag (CB.C1.b, 2026-06-20) replaces the original
 * 13-positional-param signature. Same shape is shared with the LLM path
 * (`evaluateLlmTraderEntry` takes the SAME context), so the dispatch from
 * the deterministic orchestrator to the LLM path is a single object pass.
 */
import { checkBrokerSpread, type SpreadGateResult } from "@/lib/algorithm/spread-gate";
import type { PriceBar } from "@/lib/market-data/types";
import { evaluateLiveSignal, type SignalResult } from "@/lib/signals/evaluate-live";
import {
  isPatternCondition,
  isSentimentCondition,
  isTechnicalCondition,
  type PatternCondition,
  type TechnicalCondition,
} from "@/types/algorithm";
import type { PaperPosition, PositionEvent } from "@/types/position";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  checkEntryConditions,
  normalize,
  pickConvictionMultiplier,
} from "./entry-conviction";
// CB.H1 pass 16 (2026-06-22): 11-step deterministic gate ladder extracted.
import { runDeterministicEntryGates } from "./entry-deterministic-gates";
import { evaluateLlmTraderEntry } from "./entry-llm-trader";
import { openPosition, type AlgoContext } from "./entry-open";
import { logActivity } from "./helpers";
import { type BrokerExecutionContext } from "./live-execution";

/** Options-bag for the entry path (deterministic + LLM share this shape
 *  — the dispatch is a single object pass). Fields ordered roughly by
 *  "always required" → "context that may be omitted in tests". */
export interface EntryContext {
  supabase: SupabaseClient;
  userId: string;
  algo: AlgoContext;
  ticker: string;
  bars: PriceBar[];
  closes: number[];
  allOpenPositions: PaperPosition[];
  livePrice?: number | null;
  brokerCtx?: BrokerExecutionContext | null;
  dailyBars?: PriceBar[] | null;
  /** EUR/USD 1h bars for the DXY directional filter, fetched once per
   *  scan in scanAlgorithm. Optional — null when the filter is not
   *  configured on this algo, OR when the fetch failed (gate becomes
   *  no-op via no_data status). */
  dxyBars?: PriceBar[] | null;
  /** Intermarket series (silver / 10Y yield / VIX) for the LLM-trader's
   *  prompt context. Fetched once per scan when llm_trader is enabled
   *  on a commodity algo; null otherwise. Each sub-field is independent
   *  — partial data still produces a useful summariser line. */
  intermarket?: {
    silver?: PriceBar[];
    yield10y?: PriceBar[];
    vix?: PriceBar[];
  } | null;
  /** When set, this evaluation is dry-run — the position cap (max_positions
   *  / max_per_ticker) is full so we wouldn't open even if every gate
   *  passed. We still run the full gate ladder for telemetry (each gate
   *  logs signal_no_action with its own reason on failure), but at the
   *  would-have-opened step we emit a signal_no_action with this reason
   *  instead of placing the order. Lets the operator see "the strategy
   *  fired while capped" — without this flag, the cap silently dropped
   *  every potential entry and the considered feed showed nothing during
   *  slot-full windows. */
  cappedReason?: string | null;
  /** Operator-triggered scans (the "Scan now" button) bypass the cron-
   *  alignment bar-close gate so the LLM evaluates immediately on the
   *  most recent bars. Cron-driven scans pass false (default) so the
   *  bar-close timing matches how the backtest harness evaluated. Other
   *  defensive gates (ATR liquidity, news veto, halt checks, etc.) are
   *  unaffected — those are real protections, not timing artifacts. */
  force?: boolean;
}

export async function evaluateEntry(
  ctx: EntryContext
): Promise<{ opened: number; openEvent?: PositionEvent }> {
  const {
    supabase,
    userId,
    algo,
    ticker,
    bars,
    closes,
    allOpenPositions,
    brokerCtx,
    dailyBars,
    cappedReason,
  } = ctx;
  const rules = algo.rules;

  // LLM-trader path — discretionary AI replaces pattern-detect + threshold.
  // Validated on Anthropic Haiku 4.5 across 3 historical 60d windows
  // (20 trades · 65% WR · +20.2% · 0.75% peak DD). See llm-trader.ts +
  // commit 2bea3f3 for the full prompt + iteration history. Pass through
  // the FULL context (same EntryContext shape) — no field unpacking here.
  if (rules.llm_trader?.enabled) {
    return evaluateLlmTraderEntry(ctx);
  }

  // CB.H1 pass 16 (2026-06-22): 11-step deterministic gate ladder
  // extracted to entry-deterministic-gates.ts. Returns either {blocked:true}
  // or the resolved side + higherTfBars + liquidity + currentPrice.
  const gateResult = await runDeterministicEntryGates(ctx);
  if (gateResult.blocked) return { opened: 0 };
  const { directionOverride, higherTfBars, liquidity, currentPrice } = gateResult;

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
    directionOverride,
    higherTfBars
  );
  if (!conditionsResult.pass) return { opened: 0 };
  const convictionMult = pickConvictionMultiplier(rules, conditionsResult);

  const sentimentResult = await evaluateSentimentEntries(
    supabase, userId, algo, ticker, normalizedEntry, rules
  );
  if (sentimentResult === "blocked") return { opened: 0 };
  const spread = brokerCtx ? await runBrokerSpreadGate(supabase, userId, algo.id, ticker, brokerCtx) : null;
  if (spread?.blocked) return { opened: 0 };
  const spreadResult = spread?.result ?? null;
  if (cappedReason) {
    await logCappedNearMiss(supabase, userId, algo.id, ticker, cappedReason, conditionsResult, sentimentResult, spreadResult, liquidity);
    return { opened: 0 };
  }
  await logSignalDetected(supabase, userId, algo.id, ticker, conditionsResult, sentimentResult, spreadResult, liquidity);

  return openPosition({
    supabase,
    userId,
    algo,
    ticker,
    currentPrice,
    conditions: evaluableEntry,
    sentimentResult: sentimentResult === undefined ? undefined : sentimentResult,
    allOpenPositions,
    brokerCtx: brokerCtx ?? null,
    convictionMult,
    bars,
    // adaptiveTpCtx + cohortFromCaller intentionally omitted — pattern
    // strategies don't carry regime metadata. LLM-trader fills these.
    dailyBarsForLevels: dailyBars,
  });
}

/** Evaluate sentiment-condition entries via the live signal pipeline.
 *  Returns the SignalResult when present + buy, undefined when no
 *  sentiment entry was configured, "blocked" when the signal isn't buy. */
async function evaluateSentimentEntries(
  supabase: EntryContext["supabase"],
  userId: string,
  algo: EntryContext["algo"],
  ticker: string,
  normalizedEntry: ReturnType<typeof normalize>,
  rules: EntryContext["algo"]["rules"]
): Promise<SignalResult | undefined | "blocked"> {
  const sentimentEntry = normalizedEntry.filter(isSentimentCondition);
  if (sentimentEntry.length === 0) return undefined;
  const sentimentResult = await evaluateLiveSignal(rules, ticker, algo.description);
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
    return "blocked";
  }
  return sentimentResult;
}

/** Live broker spread gate — refuses entries when bid/ask gap > catalog
 *  typical × 2.5x. Paper-only mode skips by definition. cTrader returns
 *  "skipped" and we proceed without refinement. */
async function runBrokerSpreadGate(
  supabase: EntryContext["supabase"],
  userId: string,
  algoId: string,
  ticker: string,
  brokerCtx: NonNullable<EntryContext["brokerCtx"]>
): Promise<{ blocked: boolean; result: SpreadGateResult }> {
  const spread = await checkBrokerSpread(brokerCtx.adapter, brokerCtx.conn, ticker);
  if (spread.block) {
    await logActivity(supabase, userId, {
      algorithm_id: algoId,
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
    return { blocked: true, result: spread };
  }
  return { blocked: false, result: spread };
}

/** Log the cap near-miss — full gate ladder passed + conditions matched
 *  but max_positions / max_per_ticker is full. Without this, the
 *  considered feed went dark during slot-full windows. */
async function logCappedNearMiss(
  supabase: EntryContext["supabase"],
  userId: string,
  algoId: string,
  ticker: string,
  cappedReason: string,
  conditionsResult: { met: number; total: number; fired: unknown },
  sentimentResult: SignalResult | undefined | "blocked",
  spread: SpreadGateResult | null,
  liquidity: { atr_current: number | null; atr_threshold: number | null }
): Promise<void> {
  const sentiment = typeof sentimentResult === "object" ? sentimentResult : undefined;
  await logActivity(supabase, userId, {
    algorithm_id: algoId,
    event_type: "signal_no_action",
    ticker,
    details: {
      reason: cappedReason,
      conditions_met: conditionsResult.met,
      conditions_total: conditionsResult.total,
      conditions_breakdown: conditionsResult.fired,
      sentiment_signal: sentiment?.signal,
      sentiment_confidence: sentiment?.confidence,
      observed_spread_pips: spread?.observed_spread_pips,
      spread_status: spread?.status,
      atr_current: liquidity.atr_current,
      atr_threshold: liquidity.atr_threshold,
      would_have_entered: true,
    },
  });
}

/** Log the signal_detected event — spread telemetry on every allowed
 *  entry feeds the catalog-vs-learned-p90 threshold tuning. */
async function logSignalDetected(
  supabase: EntryContext["supabase"],
  userId: string,
  algoId: string,
  ticker: string,
  conditionsResult: { met: number; total: number; fired: unknown },
  sentimentResult: SignalResult | undefined | "blocked",
  spread: SpreadGateResult | null,
  liquidity: { atr_current: number | null; atr_threshold: number | null }
): Promise<void> {
  const sentiment = typeof sentimentResult === "object" ? sentimentResult : undefined;
  await logActivity(supabase, userId, {
    algorithm_id: algoId,
    event_type: "signal_detected",
    ticker,
    details: {
      conditions_met: conditionsResult.met,
      conditions_total: conditionsResult.total,
      conditions_breakdown: conditionsResult.fired,
      sentiment_signal: sentiment?.signal,
      sentiment_confidence: sentiment?.confidence,
      observed_spread_pips: spread?.observed_spread_pips,
      spread_status: spread?.status,
      atr_current: liquidity.atr_current,
      atr_threshold: liquidity.atr_threshold,
    },
  });
}
