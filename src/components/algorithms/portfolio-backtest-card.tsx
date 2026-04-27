"use client";

import { useState } from "react";
import { Briefcase, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useRunPortfolioBacktest } from "@/hooks/use-algorithms";
import type { BacktestMetrics } from "@/lib/market-data/types";
import { pnlColorClass } from "@/lib/utils/pnl";
import { BacktestResultsDisplay } from "./backtest-results-display";

interface PortfolioBacktestCardProps {
  algorithmId: string;
  timeframe?: string;
}

function isIntraday(timeframe?: string): boolean {
  if (!timeframe) return false;
  const t = timeframe.toLowerCase();
  return t === "1h" || t === "4h" || t.endsWith("min");
}

function PerTickerTable({ rows }: { rows: NonNullable<BacktestMetrics["per_ticker"]> }) {
  if (rows.length === 0) return null;
  return (
    <div className="space-y-2">
      <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Per-pair breakdown
      </h4>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Ticker</TableHead>
            <TableHead className="text-right">Return</TableHead>
            <TableHead className="text-right">Win Rate</TableHead>
            <TableHead className="text-right">Trades</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.ticker}>
              <TableCell className="font-mono">{r.ticker}</TableCell>
              <TableCell
                className={`text-right tabular-nums font-medium ${pnlColorClass(r.return_pct)}`}
              >
                {r.return_pct >= 0 ? "+" : ""}
                {r.return_pct.toFixed(2)}%
              </TableCell>
              <TableCell className="text-right tabular-nums">{r.win_rate.toFixed(1)}%</TableCell>
              <TableCell className="text-right tabular-nums">{r.trades}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

export function PortfolioBacktestCard({
  algorithmId,
  timeframe,
}: PortfolioBacktestCardProps) {
  const intraday = isIntraday(timeframe);
  const [period, setPeriod] = useState<"compact" | "full">(intraday ? "full" : "compact");
  const [results, setResults] = useState<BacktestMetrics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mutation = useRunPortfolioBacktest();

  function handleRun() {
    setError(null);
    setResults(null);
    mutation.mutate(
      { id: algorithmId, period },
      {
        onSuccess: (r) => {
          if (r.success) setResults(r.data as BacktestMetrics);
          else setError(r.error);
        },
        onError: () => setError("Portfolio backtest failed."),
      }
    );
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <Briefcase className="h-4 w-4 text-primary" />
          Portfolio Backtest
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Runs the algorithm across every watchlist ticker simultaneously with a single shared
          capital pool — the same way paper trading will. Combined return is what matters for
          prop-firm evaluation, not single-pair backtests.
        </p>
        <div className="flex items-end gap-2">
          <div className="space-y-1.5 flex-1">
            <Select value={period} onValueChange={(v) => setPeriod(v as "compact" | "full")}>
              <SelectTrigger className="w-full">
                <SelectValue>
                  {period === "compact" ? "Last 100 bars per ticker" : "Full history per ticker"}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="compact">Last 100 bars per ticker</SelectItem>
                <SelectItem value="full">Full history per ticker</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Button onClick={handleRun} disabled={mutation.isPending}>
            {mutation.isPending ? (
              <>
                <Loader2 className="mr-2 h-3 w-3 animate-spin" />
                Running...
              </>
            ) : (
              "Run Portfolio Backtest"
            )}
          </Button>
        </div>
        {error && <p className="text-xs text-[var(--loss)]">{error}</p>}
        {results && (
          <div className="space-y-4">
            <BacktestResultsDisplay results={results} />
            {results.per_ticker && <PerTickerTable rows={results.per_ticker} />}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
