import type { AlgorithmRules, EntryCondition, ExitCondition } from "@/types/algorithm";
import { bollingerBands, ema, rsi, sma } from "./indicators";
import type { BacktestMetrics, BacktestTrade, PriceBar } from "./types";

function computeIndicator(closes: number[], name: string): (number | null)[] {
  const lower = name.toLowerCase();
  if (lower === "rsi") return rsi(closes);
  if (lower === "sma" || lower === "sma20") return sma(closes, 20);
  if (lower === "sma50") return sma(closes, 50);
  if (lower === "ema" || lower === "ema12") return ema(closes, 12);
  if (lower === "ema26") return ema(closes, 26);
  if (lower === "bollingerbands_upper") return bollingerBands(closes).upper;
  if (lower === "bollingerbands_lower") return bollingerBands(closes).lower;
  return closes.map(() => null);
}

function evaluateCondition(
  cond: EntryCondition | ExitCondition,
  values: (number | null)[],
  prevValues: (number | null)[],
  i: number
): boolean {
  const val = values[i];
  const prev = prevValues[i - 1] ?? null;
  if (val === null) return false;

  switch (cond.operator) {
    case "less_than": return val < cond.value;
    case "greater_than": return val > cond.value;
    case "crosses_above": return prev !== null && prev <= cond.value && val > cond.value;
    case "crosses_below": return prev !== null && prev >= cond.value && val < cond.value;
    default: return false;
  }
}

function checkConditions(
  conditions: (EntryCondition | ExitCondition)[],
  indicatorCache: Map<string, (number | null)[]>,
  closes: number[],
  i: number
): boolean {
  return conditions.every((c) => {
    if (!indicatorCache.has(c.indicator)) {
      indicatorCache.set(c.indicator, computeIndicator(closes, c.indicator));
    }
    const vals = indicatorCache.get(c.indicator)!;
    return evaluateCondition(c, vals, vals, i);
  });
}

function calculateMetrics(trades: BacktestTrade[], capital: number, prices: PriceBar[]): BacktestMetrics {
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
  const avgReturn = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
  const stdReturn = returns.length > 1
    ? Math.sqrt(returns.reduce((s, r) => s + (r - avgReturn) ** 2, 0) / (returns.length - 1))
    : 0;

  return {
    total_return: Number(totalReturn.toFixed(2)),
    max_drawdown: Number((maxDrawdown * 100).toFixed(2)),
    sharpe_ratio: stdReturn > 0 ? Number((avgReturn / stdReturn).toFixed(2)) : 0,
    total_trades: trades.length,
    win_rate: trades.length > 0 ? Number(((wins.length / trades.length) * 100).toFixed(1)) : 0,
    equity_curve: curve,
  };
}

export function runBacktest(rules: AlgorithmRules, prices: PriceBar[], capital: number): BacktestMetrics {
  const closes = prices.map((p) => p.close);
  const indicatorCache = new Map<string, (number | null)[]>();
  const trades: BacktestTrade[] = [];
  let inPosition = false;
  let entryPrice = 0;
  let entryDate = "";

  const posSize = (rules.position_sizing?.value ?? 10) / 100;
  const stopPct = (rules.stop_loss?.value ?? 5) / 100;
  const tpPct = (rules.take_profit?.value ?? 15) / 100;

  for (let i = 1; i < prices.length; i++) {
    if (!inPosition) {
      if (checkConditions(rules.entry_conditions, indicatorCache, closes, i)) {
        inPosition = true;
        entryPrice = closes[i];
        entryDate = prices[i].date;
      }
    } else {
      const pnlPct = (closes[i] - entryPrice) / entryPrice;
      const hitStop = pnlPct <= -stopPct;
      const hitTp = pnlPct >= tpPct;
      const hitExit = checkConditions(rules.exit_conditions, indicatorCache, closes, i);

      if (hitStop || hitTp || hitExit) {
        const positionValue = capital * posSize;
        const pnl = positionValue * pnlPct;
        trades.push({
          entry_date: entryDate,
          exit_date: prices[i].date,
          entry_price: entryPrice,
          exit_price: closes[i],
          side: "long",
          pnl: Number(pnl.toFixed(2)),
        });
        inPosition = false;
      }
    }
  }

  return calculateMetrics(trades, capital, prices);
}
