import {
  isTechnicalCondition,
  type AlgorithmRules,
  type EntryCondition,
  type ExitCondition,
  type TechnicalCondition,
} from "@/types/algorithm";
import { calculateMetrics } from "./backtest-metrics";
import { bollingerBands, ema, macd, rsi, sma } from "./indicators";
import {
  applySlippage,
  buildPropFirmReport,
  closeSimPosition,
  enforcePropFirm,
  type SimConfig,
  type SimState,
} from "./prop-firm-backtest";
import type { BacktestMetrics, BacktestTrade, OpenPosition, PriceBar } from "./types";

export type Cache = Map<string, (number | null)[]>;
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
  i: number
): boolean {
  return conditions.every((c) => {
    const vals = getValues(c.indicator, cache, closes);
    return evaluateCondition(c, vals, closes, cache, i);
  });
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

function runSimulation(
  prices: PriceBar[],
  capital: number,
  rules: AlgorithmRules,
  techEntry: TechnicalCondition[],
  techExit: TechnicalCondition[]
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
  const positions: { entryPrice: number; entryDate: string }[] = [];
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
      const exitPrice = applySlippage(closes[i], cfg.slippageBps, false);
      const pnlPct = (exitPrice - pos.entryPrice) / pos.entryPrice;
      if (
        pnlPct <= -cfg.stopPct ||
        pnlPct >= cfg.tpPct ||
        (techExit.length > 0 && checkConditions(techExit, cache, closes, i)) ||
        s.drawdownBreached
      ) {
        closeSimPosition(pos, day, exitPrice, capital, cfg, s, trades);
        positions.splice(p, 1);
        if (pf) {
          dailyHalted = enforcePropFirm(pf, s, capital, day, dailyHalted);
        }
      }
    }
    if (
      !s.killTriggered &&
      !s.drawdownBreached &&
      !dailyHalted &&
      positions.length < cfg.maxPos &&
      checkConditions(techEntry, cache, closes, i)
    ) {
      positions.push({
        entryPrice: applySlippage(closes[i], cfg.slippageBps, true),
        entryDate: day,
      });
    }
  }
  const openPos = getOpenPosition(positions, closes, capital, cfg);
  return { trades, openPos, state: s };
}

function getOpenPosition(
  positions: { entryPrice: number; entryDate: string }[],
  closes: number[],
  capital: number,
  cfg: SimConfig
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
    unrealized_pnl: Number((capital * cfg.posSize * pnlPct).toFixed(2)),
    unrealized_pnl_pct: Number((pnlPct * 100).toFixed(2)),
  };
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
