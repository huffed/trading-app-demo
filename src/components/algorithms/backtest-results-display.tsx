"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { BacktestMetrics } from "@/lib/market-data/types";
import { pnlColorClass } from "@/lib/utils/pnl";
import { EquityCurveChart } from "./equity-curve-chart";

interface BacktestResultsDisplayProps {
  results: BacktestMetrics;
}

function StatItem({ label, value, colorValue }: { label: string; value: string; colorValue?: number }) {
  return (
    <div className="space-y-0.5">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`text-sm font-medium ${colorValue != null ? pnlColorClass(colorValue) : ""}`}>
        {value}
      </p>
    </div>
  );
}

export function BacktestResultsDisplay({ results }: BacktestResultsDisplayProps) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">Backtest Results</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-3 gap-4 sm:grid-cols-5">
          <StatItem
            label="Total Return"
            value={`$${results.total_return.toFixed(2)}`}
            colorValue={results.total_return}
          />
          <StatItem label="Max Drawdown" value={`${results.max_drawdown}%`} />
          <StatItem label="Sharpe Ratio" value={results.sharpe_ratio.toString()} />
          <StatItem label="Win Rate" value={`${results.win_rate}%`} />
          <StatItem label="Total Trades" value={results.total_trades.toString()} />
        </div>
        <EquityCurveChart data={results.equity_curve} />
      </CardContent>
    </Card>
  );
}
