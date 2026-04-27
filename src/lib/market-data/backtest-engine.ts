import {
  isTechnicalCondition,
  type AlgorithmRules,
  type EntryCondition,
  type EntryLogic,
  type ExitCondition,
  type TechnicalCondition,
} from "@/types/algorithm";
import { calculateMetrics } from "./backtest-metrics";
import { buildVetoCheck, type EconomicEvent } from "./economic-calendar";
import { getValues, isPriceIndicator, type Cache } from "./indicator-registry";
import {
  applySlippage,
  buildPropFirmReport,
  closeSimPosition,
  enforcePropFirm,
  type SimConfig,
  type SimState,
} from "./prop-firm-backtest";
import type { BacktestMetrics, BacktestTrade, OpenPosition, PriceBar } from "./types";

export type { Cache } from "./indicator-registry";

export interface BacktestContext {
  symbol?: string;
  events?: EconomicEvent[];
}
function evalPriceComparison(
  cond: TechnicalCondition,
  indVals: (number | null)[],
  closes: number[],
  cache: Cache,
  i: number
): boolean {
  const ind = indVals[i];
  if (ind === null) return false;
  const prevInd = indVals[i - 1] ?? null;

  // EMA12 with value=0 → compare against EMA26 (standard crossover signal)
  if (cond.indicator.toLowerCase() === "ema12") {
    const ema26Vals = getValues("EMA26", cache, closes);
    const comp = ema26Vals[i];
    const prevComp = ema26Vals[i - 1] ?? null;
    if (comp === null) return false;
    switch (cond.operator) {
      case "less_than":
        return ind < comp;
      case "greater_than":
        return ind > comp;
      case "crosses_above":
        return prevInd !== null && prevComp !== null && prevInd <= prevComp && ind > comp;
      case "crosses_below":
        return prevInd !== null && prevComp !== null && prevInd >= prevComp && ind < comp;
    }
  }
  const price = closes[i];
  const prevPrice = closes[i - 1] ?? null;
  switch (cond.operator) {
    case "less_than":
      return price < ind;
    case "greater_than":
      return price > ind;
    case "crosses_above":
      return prevPrice !== null && prevInd !== null && prevPrice <= prevInd && price > ind;
    case "crosses_below":
      return prevPrice !== null && prevInd !== null && prevPrice >= prevInd && price < ind;
    default:
      return false;
  }
}

function evaluateCondition(
  cond: TechnicalCondition,
  indVals: (number | null)[],
  closes: number[],
  cache: Cache,
  i: number
): boolean {
  const val = indVals[i];
  if (val === null) return false;
  if (cond.value === 0 && isPriceIndicator(cond.indicator)) {
    return evalPriceComparison(cond, indVals, closes, cache, i);
  }
  const prev = indVals[i - 1] ?? null;
  switch (cond.operator) {
    case "less_than":
      return val < cond.value;
    case "greater_than":
      return val > cond.value;
    case "crosses_above":
      return prev !== null && prev <= cond.value && val > cond.value;
    case "crosses_below":
      return prev !== null && prev >= cond.value && val < cond.value;
    default:
      return false;
  }
}
export function checkConditions(
  conditions: TechnicalCondition[],
  cache: Cache,
  closes: number[],
  i: number,
  logic: EntryLogic = "all"
): boolean {
  if (conditions.length === 0) return false;
  let met = 0;
  for (const c of conditions) {
    const vals = getValues(c.indicator, cache, closes);
    if (evaluateCondition(c, vals, closes, cache, i)) met++;
  }
  if (logic === "all") return met === conditions.length;
  if (logic === "any") return met > 0;
  return met >= logic.n;
}
export function normalize(
  conditions: (EntryCondition | ExitCondition)[]
): (EntryCondition | ExitCondition)[] {
  return conditions.map((c) => {
    if (!c.type && "indicator" in c) {
      return Object.assign({}, c, { type: "technical" as const }) as TechnicalCondition;
    }
    return c;
  });
}
const DEFAULT_MAX_POSITIONS = 1;
const DEFAULT_POSITION_SIZE_PCT = 10;
const DEFAULT_STOP_LOSS_PCT = 5;
const DEFAULT_TAKE_PROFIT_PCT = 15;

/**
 * Decide whether and at what price an open position exits this bar.
 * Stops and take-profits fill at the configured level (intra-bar fill
 * detected via bar.low / bar.high). Signal-based exits fill at the close.
 * If both stop and TP touch the same bar we assume the stop fills first.
 */
function pickExitPrice(
  pos: { entryPrice: number },
  bar: PriceBar,
  closePrice: number,
  cfg: SimConfig,
  signalExitFired: boolean
): number | null {
  const stopPrice = pos.entryPrice * (1 - cfg.stopPct);
  const tpPrice = pos.entryPrice * (1 + cfg.tpPct);
  if (bar.low <= stopPrice) return applySlippage(stopPrice, cfg.slippageBps, false);
  if (bar.high >= tpPrice) return applySlippage(tpPrice, cfg.slippageBps, false);
  if (signalExitFired) return applySlippage(closePrice, cfg.slippageBps, false);
  return null;
}

function runSimulation(
  prices: PriceBar[],
  capital: number,
  rules: AlgorithmRules,
  techEntry: TechnicalCondition[],
  techExit: TechnicalCondition[],
  vetoCheck: ((barDate: string) => boolean) | null
): { trades: BacktestTrade[]; openPos: OpenPosition | null; state: SimState } {
  const pf = rules.prop_firm;
  const cfg: SimConfig = {
    slippageBps: pf?.slippage_bps ?? 0,
    commissionPct: pf?.commission_pct ?? 0,
    maxPos: rules.max_positions ?? DEFAULT_MAX_POSITIONS,
    posSize: (rules.position_sizing?.value ?? DEFAULT_POSITION_SIZE_PCT) / 100,
    stopPct: (rules.stop_loss?.value ?? DEFAULT_STOP_LOSS_PCT) / 100,
    tpPct: (rules.take_profit?.value ?? DEFAULT_TAKE_PROFIT_PCT) / 100,
  };
  const closes = prices.map((p) => p.close);
  const cache: Cache = new Map();
  const trades: BacktestTrade[] = [];
  const positions: { entryPrice: number; entryDate: string; notionalValue: number }[] = [];
  const s: SimState = {
    equity: capital,
    peakEquity: capital,
    peakDrawdownPct: 0,
    consecutiveLosses: 0,
    maxConsecLosses: 0,
    totalSlippage: 0,
    totalCommission: 0,
    killTriggered: false,
    drawdownBreached: false,
    dailyPnl: {},
  };
  let currentDay = "";
  let dailyHalted = false;

  for (let i = 1; i < prices.length; i++) {
    const bar = prices[i];
    const day = bar.date;
    if (day !== currentDay) {
      currentDay = day;
      dailyHalted = false;
    }
    const signalExitFired =
      (techExit.length > 0 && checkConditions(techExit, cache, closes, i, rules.entry_logic)) ||
      s.drawdownBreached;
    for (let p = positions.length - 1; p >= 0; p--) {
      const pos = positions[p];
      const exitPrice = pickExitPrice(pos, bar, closes[i], cfg, signalExitFired);
      if (exitPrice !== null) {
        closeSimPosition(pos, day, exitPrice, capital, cfg, s, trades);
        positions.splice(p, 1);
        if (pf) {
          dailyHalted = enforcePropFirm(pf, s, capital, day, dailyHalted);
        }
      }
    }
    const vetoed = vetoCheck ? vetoCheck(day) : false;
    if (
      !s.killTriggered &&
      !s.drawdownBreached &&
      !dailyHalted &&
      !vetoed &&
      positions.length < cfg.maxPos &&
      checkConditions(techEntry, cache, closes, i, rules.entry_logic)
    ) {
      positions.push({
        entryPrice: applySlippage(closes[i], cfg.slippageBps, true),
        entryDate: day,
        // Compound: each new position is sized off the running equity at
        // open time, not the initial capital. Wins grow future positions.
        notionalValue: s.equity * cfg.posSize,
      });
    }
  }
  const openPos = getOpenPosition(positions, closes);
  return { trades, openPos, state: s };
}

function getOpenPosition(
  positions: { entryPrice: number; entryDate: string; notionalValue: number }[],
  closes: number[]
): OpenPosition | null {
  if (positions.length === 0) {
    return null;
  }
  const lastPrice = closes[closes.length - 1];
  const pos = positions[0];
  const pnlPct = (lastPrice - pos.entryPrice) / pos.entryPrice;
  return {
    entry_date: pos.entryDate,
    entry_price: pos.entryPrice,
    current_price: lastPrice,
    side: "long",
    unrealized_pnl: Number((pos.notionalValue * pnlPct).toFixed(2)),
    unrealized_pnl_pct: Number((pnlPct * 100).toFixed(2)),
  };
}

export function runBacktest(
  rules: AlgorithmRules,
  prices: PriceBar[],
  capital: number,
  context?: BacktestContext
): BacktestMetrics {
  const entry = normalize(rules.entry_conditions);
  const exit = normalize(rules.exit_conditions);
  const techEntry = entry.filter(isTechnicalCondition);
  const techExit = exit.filter(isTechnicalCondition);
  const sentimentExcluded = entry.length - techEntry.length + (exit.length - techExit.length);
  const mode = sentimentExcluded > 0 ? ("technical_only" as const) : ("full" as const);

  if (techEntry.length === 0) {
    return {
      ...calculateMetrics([], capital, prices, null),
      sentiment_conditions_excluded: sentimentExcluded,
      backtest_mode: mode,
    };
  }

  const vetoCheck = rules.news_veto?.enabled
    ? buildVetoCheck({ symbol: context?.symbol, events: context?.events, veto: rules.news_veto })
    : null;
  const { trades, openPos, state } = runSimulation(
    prices,
    capital,
    rules,
    techEntry,
    techExit,
    vetoCheck
  );
  const result: BacktestMetrics = {
    ...calculateMetrics(trades, capital, prices, openPos),
    sentiment_conditions_excluded: sentimentExcluded,
    backtest_mode: mode,
  };

  if (rules.prop_firm) {
    result.prop_firm_report = buildPropFirmReport(
      rules.prop_firm,
      capital,
      trades,
      state.dailyPnl,
      state.totalSlippage,
      state.totalCommission,
      state.peakDrawdownPct,
      state.maxConsecLosses,
      state.killTriggered,
      state.drawdownBreached
    );
  }
  return result;
}
