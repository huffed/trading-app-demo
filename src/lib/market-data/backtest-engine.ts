import { isTechnicalCondition, type AlgorithmRules, type TechnicalCondition } from "@/types/algorithm";
import { bollingerBands, ema, macd, rsi, sma } from "./indicators";
import type { BacktestMetrics, BacktestTrade, OpenPosition, PriceBar } from "./types";

type Cache = Map<string, (number | null)[]>;

function computeIndicator(closes: number[], name: string): (number | null)[] {
  const lower = name.toLowerCase();
  if (lower === "rsi") { return rsi(closes); }
  if (lower === "sma" || lower === "sma20") { return sma(closes, 20); }
  if (lower === "sma50") { return sma(closes, 50); }
  if (lower === "ema" || lower === "ema12") { return ema(closes, 12); }
  if (lower === "ema26") { return ema(closes, 26); }
  if (lower === "macd") { return macd(closes); }
  if (lower === "bollingerbands_upper") { return bollingerBands(closes).upper; }
  if (lower === "bollingerbands_lower") { return bollingerBands(closes).lower; }
  return closes.map(() => null);
}

function getValues(name: string, cache: Cache, closes: number[]): (number | null)[] {
  if (!cache.has(name)) { cache.set(name, computeIndicator(closes, name)); }
  return cache.get(name)!;
}

function isPriceIndicator(name: string): boolean {
  const l = name.toLowerCase();
  return l.startsWith("sma") || l.startsWith("ema") || l.startsWith("bollinger");
}

// When value=0 for MAs/BBs, compare price against the indicator (or EMA12 against EMA26)
function evalPriceComparison(
  cond: TechnicalCondition, indVals: (number | null)[], closes: number[], cache: Cache, i: number
): boolean {
  const ind = indVals[i];
  if (ind === null) { return false; }
  const prevInd = indVals[i - 1] ?? null;

  // EMA12 crossover: compare against EMA26
  if (cond.indicator.toLowerCase() === "ema12") {
    const ema26 = getValues("EMA26", cache, closes);
    const comp = ema26[i];
    const prevComp = ema26[i - 1] ?? null;
    if (comp === null) { return false; }
    switch (cond.operator) {
      case "less_than": return ind < comp;
      case "greater_than": return ind > comp;
      case "crosses_above": return prevInd !== null && prevComp !== null && prevInd <= prevComp && ind > comp;
      case "crosses_below": return prevInd !== null && prevComp !== null && prevInd >= prevComp && ind < comp;
    }
  }

  // All other MAs and BBs: compare closing price against indicator value
  const price = closes[i];
  const prevPrice = closes[i - 1] ?? null;
  switch (cond.operator) {
    case "less_than": return price < ind;
    case "greater_than": return price > ind;
    case "crosses_above": return prevPrice !== null && prevInd !== null && prevPrice <= prevInd && price > ind;
    case "crosses_below": return prevPrice !== null && prevInd !== null && prevPrice >= prevInd && price < ind;
    default: return false;
  }
}

function evaluateCondition(
  cond: TechnicalCondition, indVals: (number | null)[], closes: number[], cache: Cache, i: number
): boolean {
  const val = indVals[i];
  if (val === null) { return false; }

  // value=0 on price-based indicators uses special comparison semantics
  if (cond.value === 0 && isPriceIndicator(cond.indicator)) {
    return evalPriceComparison(cond, indVals, closes, cache, i);
  }

  // Standard literal comparison (RSI thresholds, MACD zero line, etc.)
  const prev = indVals[i - 1] ?? null;
  switch (cond.operator) {
    case "less_than": return val < cond.value;
    case "greater_than": return val > cond.value;
    case "crosses_above": return prev !== null && prev <= cond.value && val > cond.value;
    case "crosses_below": return prev !== null && prev >= cond.value && val < cond.value;
    default: return false;
  }
}

function checkConditions(conditions: TechnicalCondition[], cache: Cache, closes: number[], i: number): boolean {
  return conditions.every((c) => {
    const vals = getValues(c.indicator, cache, closes);
    return evaluateCondition(c, vals, closes, cache, i);
  });
}

function calculateMetrics(trades: BacktestTrade[], capital: number, prices: PriceBar[], openPos: OpenPosition | null): Omit<BacktestMetrics, "sentiment_conditions_excluded" | "backtest_mode"> {
  const wins = trades.filter((t) => t.pnl > 0);
  const totalReturn = trades.reduce((s, t) => s + t.pnl, 0);
  let equity = capital;
  let peak = capital;
  let maxDrawdown = 0;
  const curve: { date: string; value: number }[] = [{ date: prices[0]?.date ?? "", value: capital }];
  for (const t of trades) {
    equity += t.pnl;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak);
    curve.push({ date: t.exit_date, value: Number(equity.toFixed(2)) });
  }
  const returns = trades.map((t) => t.pnl / capital);
  const avg = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
  const std = returns.length > 1
    ? Math.sqrt(returns.reduce((s, r) => s + (r - avg) ** 2, 0) / (returns.length - 1))
    : 0;
  return {
    total_return: Number(totalReturn.toFixed(2)),
    max_drawdown: Number((maxDrawdown * 100).toFixed(2)),
    sharpe_ratio: std > 0 ? Number((avg / std).toFixed(2)) : 0,
    total_trades: trades.length,
    win_rate: trades.length > 0 ? Number(((wins.length / trades.length) * 100).toFixed(1)) : 0,
    equity_curve: curve,
    open_position: openPos,
  };
}

export function runBacktest(rules: AlgorithmRules, prices: PriceBar[], capital: number): BacktestMetrics {
  // Partition conditions — only technical conditions can be backtested
  const techEntry = rules.entry_conditions.filter(isTechnicalCondition);
  const techExit = rules.exit_conditions.filter(isTechnicalCondition);
  const sentimentExcluded =
    (rules.entry_conditions.length - techEntry.length) + (rules.exit_conditions.length - techExit.length);
  const mode = sentimentExcluded > 0 ? "technical_only" as const : "full" as const;

  // If no technical entry conditions remain, we can't run a meaningful backtest
  if (techEntry.length === 0) {
    return {
      ...calculateMetrics([], capital, prices, null),
      sentiment_conditions_excluded: sentimentExcluded,
      backtest_mode: mode,
    };
  }

  const closes = prices.map((p) => p.close);
  const cache: Cache = new Map();
  const trades: BacktestTrade[] = [];
  let inPosition = false;
  let entryPrice = 0;
  let entryDate = "";
  const posSize = (rules.position_sizing?.value ?? 10) / 100;
  const stopPct = (rules.stop_loss?.value ?? 5) / 100;
  const tpPct = (rules.take_profit?.value ?? 15) / 100;

  for (let i = 1; i < prices.length; i++) {
    if (!inPosition) {
      if (checkConditions(techEntry, cache, closes, i)) {
        inPosition = true;
        entryPrice = closes[i];
        entryDate = prices[i].date;
      }
    } else {
      const pnlPct = (closes[i] - entryPrice) / entryPrice;
      const hitStop = pnlPct <= -stopPct;
      const hitTp = pnlPct >= tpPct;
      const hitExit = techExit.length > 0 && checkConditions(techExit, cache, closes, i);
      if (hitStop || hitTp || hitExit) {
        const pnl = capital * posSize * pnlPct;
        trades.push({
          entry_date: entryDate, exit_date: prices[i].date,
          entry_price: entryPrice, exit_price: closes[i],
          side: "long", pnl: Number(pnl.toFixed(2)),
        });
        inPosition = false;
      }
    }
  }

  // Capture open position at end of backtest period
  let openPos: OpenPosition | null = null;
  if (inPosition && prices.length > 0) {
    const lastPrice = closes[closes.length - 1];
    const pnlPct = (lastPrice - entryPrice) / entryPrice;
    openPos = {
      entry_date: entryDate,
      entry_price: entryPrice,
      current_price: lastPrice,
      side: "long",
      unrealized_pnl: Number((capital * posSize * pnlPct).toFixed(2)),
      unrealized_pnl_pct: Number((pnlPct * 100).toFixed(2)),
    };
  }

  return {
    ...calculateMetrics(trades, capital, prices, openPos),
    sentiment_conditions_excluded: sentimentExcluded,
    backtest_mode: mode,
  };
}
