import type { BacktestMetrics, BacktestTrade, OpenPosition, PriceBar } from "./types";

export function calculateMetrics(
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
