"use client";

import { AlertCircle, TrendingUp } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { BacktestMetrics } from "@/lib/market-data/types";
import { pnlColorClass } from "@/lib/utils/pnl";
import { EquityCurveChart } from "./equity-curve-chart";
import { PropFirmReportCard } from "./prop-firm-report";
import { TradeChart } from "./trade-chart";

interface BacktestResultsDisplayProps {
  results: BacktestMetrics;
  symbol?: string;
}

function StatItem({
  label,
  value,
  colorValue,
}: {
  label: string;
  value: string;
  colorValue?: number;
}) {
  return (
    <div className="space-y-0.5">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`text-sm font-medium ${colorValue != null ? pnlColorClass(colorValue) : ""}`}>
        {value}
      </p>
    </div>
  );
}

function NoTradesExplanation() {
  return (
    <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-2">
      <div className="flex items-center gap-2">
        <AlertCircle className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium">No trades triggered</span>
      </div>
      <p className="text-xs text-muted-foreground leading-relaxed">
        The algorithm&apos;s entry conditions were never met simultaneously during this period. This
        happens when conditions are too strict (e.g., RSI below 30 AND EMA crossover AND Bollinger
        touch all at once). Try a different symbol, a longer period, or regenerate the algorithm
        with fewer entry conditions.
      </p>
    </div>
  );
}

/** `backtest_results` is JSONB on the algorithm row, so any field can be
 *  absent depending on which engine produced the row (single-ticker
 *  backtest, portfolio backtest, LLM-trader walk-forward summary, hand-
 *  populated baselines for drift detection). The component must render
 *  without crashing on any subset of fields. Numeric fields fall back to
 *  0; the dash-marker ("—") is reserved for fields that are
 *  deliberately not computable from the source (e.g. Sharpe on a row
 *  populated only with aggregate WF stats). */
function format(n: number | undefined | null, suffix: string, decimals = 2): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${n.toFixed(decimals)}${suffix}`;
}

export function BacktestResultsDisplay({ results, symbol }: BacktestResultsDisplayProps) {
  const totalTrades = results.total_trades ?? 0;
  const noTrades = totalTrades === 0;
  const totalReturn = results.total_return ?? 0;
  const equityCurve = results.equity_curve ?? [];
  const prices = results.prices ?? [];
  const trades = results.trades ?? [];

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">
          Backtest Results{symbol ? ` — ${symbol}` : ""}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-3 gap-4 sm:grid-cols-5">
          <StatItem
            label="Total Return"
            value={`$${totalReturn.toFixed(2)}`}
            colorValue={totalReturn}
          />
          <StatItem label="Max Drawdown" value={format(results.max_drawdown, "%")} />
          <StatItem label="Sharpe Ratio" value={format(results.sharpe_ratio, "", 2)} />
          <StatItem label="Win Rate" value={format(results.win_rate, "%", 1)} />
          <StatItem label="Total Trades" value={totalTrades.toString()} />
        </div>
        {results.open_position && (
          <div className="rounded-lg border border-primary/20 bg-primary/5 p-3 space-y-1">
            <div className="flex items-center gap-2">
              <TrendingUp className="h-4 w-4 text-primary" />
              <span className="text-sm font-medium">Open Position</span>
            </div>
            <p className="text-xs text-muted-foreground">
              Entered {results.open_position.entry_date} at $
              {results.open_position.entry_price.toFixed(2)} — now $
              {results.open_position.current_price.toFixed(2)}
            </p>
            <p
              className={`text-sm font-medium ${pnlColorClass(results.open_position.unrealized_pnl)}`}
            >
              Unrealized: ${results.open_position.unrealized_pnl.toFixed(2)} (
              {results.open_position.unrealized_pnl_pct.toFixed(1)}%)
            </p>
          </div>
        )}
        {results.prop_firm_report && <PropFirmReportCard report={results.prop_firm_report} />}
        {noTrades && !results.open_position && <NoTradesExplanation />}
        {!noTrades && prices.length > 0 && <TradeChart prices={prices} trades={trades} />}
        {!noTrades && prices.length === 0 && equityCurve.length >= 2 && (
          <EquityCurveChart data={equityCurve} />
        )}
      </CardContent>
    </Card>
  );
}
