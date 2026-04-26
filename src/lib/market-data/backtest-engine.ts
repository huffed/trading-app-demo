/**
 * Backtest engine — runs algorithm rules against historical price data.
 *
 * Architecture:
 *   1. Conditions are normalized (legacy format → discriminated union)
 *   2. Sentiment conditions are filtered out (can't historically backtest news)
 *   3. Technical conditions are evaluated per bar using cached indicator values
 *   4. Simulation tracks positions, P&L, drawdown, and prop firm compliance
 *   5. Metrics are calculated from the simulated trade list
 *
 * Key design decisions:
 * - When value=0 on a price-based indicator (SMA/EMA/BB), we compare indicator
 *   vs price (not indicator vs 0). This is how the LLM generates crossover signals.
 * - EMA12 with value=0 is special-cased to compare against EMA26 (MACD crossover).
 * - Prop firm rules are enforced during simulation (daily loss halt, drawdown breach,
 *   consecutive loss kill switch) — but only AFTER the losing trade is realized.
 * - All conditions use AND logic (all must fire). clampRules() limits condition
 *   count to prevent zero-trade backtests.
 */
import {
  isTechnicalCondition,
  type AlgorithmRules,
  type EntryCondition,
  type ExitCondition,
  type PropFirmRules,
  type TechnicalCondition,
} from "@/types/algorithm";
import { bollingerBands, ema, macd, rsi, sma } from "./indicators";
import type {
  BacktestMetrics,
  BacktestTrade,
  OpenPosition,
  PriceBar,
  PropFirmReport,
} from "./types";

export type Cache = Map<string, (number | null)[]>;

/** Mapping of supported indicator names (lowercased) to their computation functions. */
const INDICATOR_REGISTRY: Record<string, (closes: number[]) => (number | null)[]> = {
  rsi: (c) => rsi(c),
  sma: (c) => sma(c, 20),
  sma20: (c) => sma(c, 20),
  sma50: (c) => sma(c, 50),
  ema: (c) => ema(c, 12),
  ema12: (c) => ema(c, 12),
  ema26: (c) => ema(c, 26),
  macd: (c) => macd(c),
  bollingerbands_upper: (c) => bollingerBands(c).upper,
  bollingerbands_lower: (c) => bollingerBands(c).lower,
};

function computeIndicator(closes: number[], name: string): (number | null)[] {
  const fn = INDICATOR_REGISTRY[name.toLowerCase()];
  if (!fn) {
    console.warn(`[backtest] Unsupported indicator "${name}" — condition will never trigger`);
    return closes.map(() => null);
  }
  return fn(closes);
}

function getValues(name: string, cache: Cache, closes: number[]): (number | null)[] {
  if (!cache.has(name)) cache.set(name, computeIndicator(closes, name));
  const vals = cache.get(name);
  if (!vals) throw new Error(`Indicator "${name}" failed to compute`);
  return vals;
}

function isPriceIndicator(name: string): boolean {
  const l = name.toLowerCase();
  return l.startsWith("sma") || l.startsWith("ema") || l.startsWith("bollinger");
}

/**
 * When a price-based indicator has value=0, we compare the indicator against price
 * (e.g., "price crosses above SMA20") rather than checking indicator > 0.
 *
 * Special case: EMA12 with value=0 compares against EMA26 instead of price,
 * because EMA12/EMA26 crossover is the standard MACD signal interpretation.
 * The LLM generates this as "EMA12 crosses_above 0" meaning "EMA12 crosses above EMA26".
 */
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
  if (cond.value === 0 && isPriceIndicator(cond.indicator))
    return evalPriceComparison(cond, indVals, closes, cache, i);
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
  i: number
): boolean {
  return conditions.every((c) => {
    const vals = getValues(c.indicator, cache, closes);
    return evaluateCondition(c, vals, closes, cache, i);
  });
}

/**
 * Defensive normalization for legacy conditions stored in DB without a `type` field.
 * The Zod validator (lib/validators/algorithm.ts) also normalizes at parse time,
 * but rules loaded from Supabase JSONB may bypass validation — this is the safety net.
 */
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

// --- Prop firm helpers ---

function applySlippage(price: number, bps: number, isBuy: boolean): number {
  const slip = price * (bps / 10000);
  return isBuy ? price + slip : price - slip;
}

function buildPropFirmReport(
  pf: PropFirmRules,
  capital: number,
  trades: BacktestTrade[],
  dailyPnl: Record<string, number>,
  totalSlippage: number,
  totalCommission: number,
  peakDrawdownPct: number,
  maxConsecLosses: number,
  killTriggered: boolean,
  drawdownBreached: boolean
): PropFirmReport {
  const totalProfit = trades.reduce((s, t) => s + t.pnl, 0);
  const dailyLosses = Object.values(dailyPnl);
  const dailyLossPctValues = dailyLosses.map((d) => (d / capital) * 100);
  const maxDailyLoss = dailyLossPctValues.length > 0 ? Math.min(...dailyLossPctValues) : 0;
  const dailyLossBreaches = dailyLossPctValues.filter((d) => d <= -pf.daily_loss_limit).length;

  // Consistency: no single day's profit > X% of total profit
  const totalPositiveProfit = dailyLosses.filter((d) => d > 0).reduce((s, d) => s + d, 0);
  let worstDayPct = 0;
  let consistencyPass = true;
  if (totalPositiveProfit > 0) {
    const dailyProfitPcts = dailyLosses
      .filter((d) => d > 0)
      .map((d) => (d / totalPositiveProfit) * 100);
    worstDayPct = dailyProfitPcts.length > 0 ? Math.max(...dailyProfitPcts) : 0;
    consistencyPass = worstDayPct <= pf.consistency_rule;
  }

  const profitTargetMet = (totalProfit / capital) * 100 >= pf.profit_target;

  const failReasons: string[] = [];
  if (dailyLossBreaches > 0)
    failReasons.push(`Daily loss limit breached ${dailyLossBreaches} time(s)`);
  if (drawdownBreached) failReasons.push(`Max drawdown exceeded ${pf.max_drawdown}%`);
  if (killTriggered)
    failReasons.push(`${maxConsecLosses} consecutive losses triggered kill switch`);
  if (!consistencyPass)
    failReasons.push(
      `Single day contributed ${worstDayPct.toFixed(0)}% of total profit (limit: ${pf.consistency_rule}%)`
    );
  if (!profitTargetMet)
    failReasons.push(
      `Profit target ${pf.profit_target}% not met (achieved: ${((totalProfit / capital) * 100).toFixed(1)}%)`
    );

  return {
    daily_loss_breaches: dailyLossBreaches,
    max_daily_loss: Number(Math.abs(maxDailyLoss).toFixed(2)),
    peak_drawdown: Number(peakDrawdownPct.toFixed(2)),
    drawdown_breached: drawdownBreached,
    max_consecutive_losses: maxConsecLosses,
    kill_switch_triggered: killTriggered,
    consistency_pass: consistencyPass,
    worst_day_pct_of_profit: Number(worstDayPct.toFixed(1)),
    total_slippage: Number(totalSlippage.toFixed(2)),
    total_commission: Number(totalCommission.toFixed(2)),
    profit_target_met: profitTargetMet,
    evaluation_result: failReasons.length === 0 && profitTargetMet ? "pass" : "fail",
    fail_reasons: failReasons,
  };
}

// --- Metrics ---

function calculateMetrics(
  trades: BacktestTrade[],
  capital: number,
  prices: PriceBar[],
  openPos: OpenPosition | null
): Omit<BacktestMetrics, "sentiment_conditions_excluded" | "backtest_mode" | "prop_firm_report"> {
  const wins = trades.filter((t) => t.pnl > 0);
  const totalReturn = trades.reduce((s, t) => s + t.pnl, 0);
  let equity = capital;
  let peak = capital;
  let maxDrawdown = 0;
  const curve: { date: string; value: number }[] = [
    { date: prices[0]?.date ?? "", value: capital },
  ];
  for (const t of trades) {
    equity += t.pnl;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak);
    curve.push({ date: t.exit_date, value: Number(equity.toFixed(2)) });
  }
  const returns = trades.map((t) => t.pnl / capital);
  const avg = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
  const std =
    returns.length > 1
      ? Math.sqrt(returns.reduce((s, r) => s + (r - avg) ** 2, 0) / (returns.length - 1))
      : 0;
  return {
    total_return: Number(totalReturn.toFixed(2)),
    max_drawdown: Number((maxDrawdown * 100).toFixed(2)),
    sharpe_ratio: std > 0 ? Number((avg / std).toFixed(2)) : 0,
    total_trades: trades.length,
    win_rate: trades.length > 0 ? Number(((wins.length / trades.length) * 100).toFixed(1)) : 0,
    equity_curve: curve,
    trades,
    prices,
    open_position: openPos,
  };
}

// --- Default risk parameters (used when algorithm doesn't specify) ---

const DEFAULT_MAX_POSITIONS = 1;
const DEFAULT_POSITION_SIZE_PCT = 10;
const DEFAULT_STOP_LOSS_PCT = 5;
const DEFAULT_TAKE_PROFIT_PCT = 15;

// --- Main backtest ---

interface SimState {
  equity: number;
  peakEquity: number;
  peakDrawdownPct: number;
  consecutiveLosses: number;
  maxConsecLosses: number;
  totalSlippage: number;
  totalCommission: number;
  killTriggered: boolean;
  drawdownBreached: boolean;
  dailyPnl: Record<string, number>;
}

function runSimulation(
  prices: PriceBar[],
  capital: number,
  rules: AlgorithmRules,
  techEntry: TechnicalCondition[],
  techExit: TechnicalCondition[]
): { trades: BacktestTrade[]; openPos: OpenPosition | null; state: SimState } {
  const pf = rules.prop_firm;
  const slippageBps = pf?.slippage_bps ?? 0;
  const commissionPct = pf?.commission_pct ?? 0;
  const closes = prices.map((p) => p.close);
  const cache: Cache = new Map();
  const trades: BacktestTrade[] = [];
  const positions: { entryPrice: number; entryDate: string }[] = [];
  const maxPos = rules.max_positions ?? DEFAULT_MAX_POSITIONS;
  const posSize = (rules.position_sizing?.value ?? DEFAULT_POSITION_SIZE_PCT) / 100;
  const stopPct = (rules.stop_loss?.value ?? DEFAULT_STOP_LOSS_PCT) / 100;
  const tpPct = (rules.take_profit?.value ?? DEFAULT_TAKE_PROFIT_PCT) / 100;
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
    const day = prices[i].date;
    if (day !== currentDay) {
      currentDay = day;
      dailyHalted = false;
    }
    for (let p = positions.length - 1; p >= 0; p--) {
      const pos = positions[p];
      const exitPrice = applySlippage(closes[i], slippageBps, false);
      const pnlPct = (exitPrice - pos.entryPrice) / pos.entryPrice;
      if (
        pnlPct <= -stopPct ||
        pnlPct >= tpPct ||
        (techExit.length > 0 && checkConditions(techExit, cache, closes, i)) ||
        s.drawdownBreached
      ) {
        const commission = capital * posSize * (commissionPct / 100) * 2;
        const pnl = Number((capital * posSize * pnlPct - commission).toFixed(2));
        s.totalSlippage +=
          ((pos.entryPrice + exitPrice) * (slippageBps / 10000) * capital * posSize) / exitPrice;
        s.totalCommission += commission;
        trades.push({
          entry_date: pos.entryDate,
          exit_date: day,
          entry_price: pos.entryPrice,
          exit_price: exitPrice,
          side: "long",
          pnl,
        });
        positions.splice(p, 1);
        s.equity += pnl;
        s.peakEquity = Math.max(s.peakEquity, s.equity);
        const ddPct = ((s.peakEquity - s.equity) / capital) * 100;
        s.peakDrawdownPct = Math.max(s.peakDrawdownPct, ddPct);
        s.dailyPnl[day] = (s.dailyPnl[day] ?? 0) + pnl;
        if (pnl < 0) {
          s.consecutiveLosses++;
          s.maxConsecLosses = Math.max(s.maxConsecLosses, s.consecutiveLosses);
        } else s.consecutiveLosses = 0;
        if (pf) {
          if (pf.max_drawdown > 0 && ddPct >= pf.max_drawdown) s.drawdownBreached = true;
          if (pf.max_consecutive_losses > 0 && s.consecutiveLosses >= pf.max_consecutive_losses)
            s.killTriggered = true;
          if (
            pf.daily_loss_limit > 0 &&
            ((s.dailyPnl[day] ?? 0) / capital) * 100 <= -pf.daily_loss_limit
          )
            dailyHalted = true;
        }
      }
    }
    if (
      !s.killTriggered &&
      !s.drawdownBreached &&
      !dailyHalted &&
      positions.length < maxPos &&
      checkConditions(techEntry, cache, closes, i)
    ) {
      positions.push({ entryPrice: applySlippage(closes[i], slippageBps, true), entryDate: day });
    }
  }
  let openPos: OpenPosition | null = null;
  if (positions.length > 0) {
    const lastPrice = closes[closes.length - 1];
    const pos = positions[0];
    const pnlPct = (lastPrice - pos.entryPrice) / pos.entryPrice;
    openPos = {
      entry_date: pos.entryDate,
      entry_price: pos.entryPrice,
      current_price: lastPrice,
      side: "long",
      unrealized_pnl: Number((capital * posSize * pnlPct).toFixed(2)),
      unrealized_pnl_pct: Number((pnlPct * 100).toFixed(2)),
    };
  }
  return { trades, openPos, state: s };
}

export function runBacktest(
  rules: AlgorithmRules,
  prices: PriceBar[],
  capital: number
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

  const { trades, openPos, state } = runSimulation(prices, capital, rules, techEntry, techExit);
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
