"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight, FlaskConical, Loader2 } from "lucide-react";
import { backtestTicker } from "@/app/(dashboard)/algorithms/backtest-actions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { BacktestMetrics } from "@/lib/market-data/types";
import { pnlColorClass } from "@/lib/utils/pnl";
import { BacktestResultsDisplay } from "./backtest-results-display";

export interface TickerInfo {
  ticker: string;
  name: string;
  backtestMetrics?: BacktestMetrics | null;
}

function RankingRow({
  ticker,
  name,
  metrics,
  error,
  isExpanded,
  onToggle,
}: {
  ticker: string;
  name: string;
  metrics?: BacktestMetrics;
  error?: string;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  if (error) {
    return (
      <div className="flex items-center gap-2 py-2 text-xs">
        <span className="font-mono font-medium min-w-[60px]">{ticker}</span>
        <span className="text-muted-foreground truncate flex-1">{name}</span>
        <span className="text-[var(--loss)]">Failed</span>
      </div>
    );
  }
  if (!metrics) return null;

  return (
    <div className="space-y-2">
      <button
        onClick={onToggle}
        className="flex items-center gap-2 py-2 w-full text-left cursor-pointer"
        type="button"
      >
        {isExpanded ? (
          <ChevronDown className="h-3 w-3 shrink-0" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0" />
        )}
        <span className="font-mono text-sm font-medium min-w-[60px]">{ticker}</span>
        <span className="text-xs text-muted-foreground truncate flex-1">{name}</span>
        <span className={`text-xs font-medium tabular-nums ${pnlColorClass(metrics.total_return)}`}>
          {metrics.total_return >= 0 ? "+" : ""}
          {metrics.total_return.toFixed(2)}%
        </span>
        <span className="text-xs tabular-nums text-muted-foreground w-12 text-right">
          {metrics.win_rate.toFixed(0)}% W
        </span>
        <span className="text-xs tabular-nums text-muted-foreground w-8 text-right">
          {metrics.total_trades}t
        </span>
      </button>
      {isExpanded && <BacktestResultsDisplay results={metrics} symbol={ticker} />}
    </div>
  );
}

function RankingTable({
  results,
  errors,
  tickers,
}: {
  results: Record<string, BacktestMetrics>;
  errors: Record<string, string>;
  tickers: TickerInfo[];
}) {
  const [expandedTicker, setExpandedTicker] = useState<string | null>(null);

  const ranked = tickers
    .filter((t) => results[t.ticker])
    .sort(
      (a, b) => (results[b.ticker]?.total_return ?? 0) - (results[a.ticker]?.total_return ?? 0)
    );

  const failed = tickers.filter((t) => errors[t.ticker]);

  return (
    <div className="divide-y">
      {ranked.map((t) => (
        <RankingRow
          key={t.ticker}
          ticker={t.ticker}
          name={t.name}
          metrics={results[t.ticker]}
          isExpanded={expandedTicker === t.ticker}
          onToggle={() => setExpandedTicker((p) => (p === t.ticker ? null : t.ticker))}
        />
      ))}
      {failed.map((t) => (
        <RankingRow
          key={t.ticker}
          ticker={t.ticker}
          name={t.name}
          error={errors[t.ticker]}
          isExpanded={false}
          onToggle={() => {}}
        />
      ))}
    </div>
  );
}

export function BacktestRankingCard({
  algorithmId,
  tickers,
}: {
  algorithmId: string;
  tickers: TickerInfo[];
}) {
  const initial: Record<string, BacktestMetrics> = {};
  for (const t of tickers) {
    if (t.backtestMetrics) initial[t.ticker] = t.backtestMetrics;
  }
  const [results, setResults] = useState<Record<string, BacktestMetrics>>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [isRunning, setIsRunning] = useState(false);
  const [progress, setProgress] = useState(0);

  const hasResults = Object.keys(results).length > 0 || Object.keys(errors).length > 0;

  async function handleBacktestAll() {
    setIsRunning(true);
    setProgress(0);
    setResults({});
    setErrors({});
    for (const t of tickers) {
      try {
        const result = await backtestTicker(algorithmId, t.ticker);
        if (result.success)
          setResults((prev) => ({ ...prev, [t.ticker]: result.data as BacktestMetrics }));
        else setErrors((prev) => ({ ...prev, [t.ticker]: result.error }));
      } catch {
        setErrors((prev) => ({ ...prev, [t.ticker]: "Backtest failed" }));
      }
      setProgress((p) => p + 1);
    }
    setIsRunning(false);
  }

  if (tickers.length === 0) return null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <FlaskConical className="h-4 w-4" />
          Watchlist Backtest
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Run your algorithm against every ticker in the watchlist. Results ranked by return.
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={handleBacktestAll}
          disabled={isRunning}
          className="w-full"
        >
          {isRunning ? (
            <>
              <Loader2 className="mr-2 h-3 w-3 animate-spin" />
              Backtesting... ({progress}/{tickers.length})
            </>
          ) : (
            "Backtest Watchlist"
          )}
        </Button>
        {hasResults && <RankingTable results={results} errors={errors} tickers={tickers} />}
      </CardContent>
    </Card>
  );
}
