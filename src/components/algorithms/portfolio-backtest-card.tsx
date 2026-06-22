"use client";

import { useState } from "react";
import { Briefcase, CheckCircle2, Loader2, XCircle } from "lucide-react";
import { runPortfolioBacktest } from "@/app/(dashboard)/algorithms/backtest-run-actions";
import { Badge } from "@/components/ui/badge";
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

const WINDOW_LABELS: Record<string, string> = {
  "1m": "Last 1 month",
  "3m": "Last 3 months",
  "6m": "Last 6 months",
  "1y": "Last 1 year",
  all: "All available",
};
const COMPARE_WINDOWS = ["1m", "3m", "6m", "1y"] as const;
type Window = (typeof COMPARE_WINDOWS)[number] | "all";

/** Trades below this are too few to draw any conclusion from. */
const LOW_SAMPLE_THRESHOLD = 30;

/** 95% Wilson confidence interval half-width on a binomial win rate.
 *  Returns the ± margin in percentage points. */
function winRateCi(winRatePct: number, n: number): number {
  if (n <= 0) return 0;
  const p = winRatePct / 100;
  const z = 1.96;
  const denom = 1 + (z * z) / n;
  const center = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  const lower = (center - margin) / denom;
  const upper = (center + margin) / denom;
  return ((upper - lower) / 2) * 100;
}

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

interface WindowResult {
  window: Window;
  metrics: BacktestMetrics | null;
  loading: boolean;
  error: string | null;
}

function ftmoOk(m: BacktestMetrics): boolean {
  return m.prop_firm_report?.evaluation_result === "pass";
}

function ComparisonTable({ rows }: { rows: WindowResult[] }) {
  return (
    <div className="space-y-2">
      <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Window comparison
      </h4>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Window</TableHead>
            <TableHead className="text-right">Return</TableHead>
            <TableHead className="text-right">Max DD</TableHead>
            <TableHead className="text-right">Win Rate</TableHead>
            <TableHead className="text-right">Trades</TableHead>
            <TableHead className="text-right">FTMO</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.window}>
              <TableCell className="font-medium">{WINDOW_LABELS[r.window]}</TableCell>
              {r.loading ? (
                <TableCell colSpan={5} className="text-xs text-muted-foreground">
                  <Loader2 className="inline h-3 w-3 animate-spin mr-1.5" /> running...
                </TableCell>
              ) : r.error ? (
                <TableCell colSpan={5} className="text-xs text-[var(--loss)]">
                  {r.error}
                </TableCell>
              ) : r.metrics ? (
                <ComparisonMetrics m={r.metrics} />
              ) : (
                <TableCell colSpan={5} className="text-xs text-muted-foreground">
                  —
                </TableCell>
              )}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function FtmoBadge({ m }: { m: BacktestMetrics }) {
  if (!m.prop_firm_report) return <span className="text-xs text-muted-foreground">—</span>;
  return ftmoOk(m) ? (
    <Badge className="bg-[var(--profit)]/15 text-[var(--profit)]">
      <CheckCircle2 className="mr-1 h-3 w-3" /> Pass
    </Badge>
  ) : (
    <Badge className="bg-[var(--loss)]/15 text-[var(--loss)]">
      <XCircle className="mr-1 h-3 w-3" /> Fail
    </Badge>
  );
}

function ComparisonMetrics({ m }: { m: BacktestMetrics }) {
  const ci = winRateCi(m.win_rate, m.total_trades);
  const lowSample = m.total_trades < LOW_SAMPLE_THRESHOLD;
  return (
    <>
      <TableCell
        className={`text-right tabular-nums font-medium ${pnlColorClass(m.total_return)}`}
      >
        {m.total_return >= 0 ? "+" : "-"}${Math.abs(m.total_return).toFixed(0)}
      </TableCell>
      <TableCell className="text-right tabular-nums">{m.max_drawdown.toFixed(2)}%</TableCell>
      <TableCell className="text-right tabular-nums">
        <div className="flex flex-col items-end">
          <span>{m.win_rate.toFixed(1)}%</span>
          {m.total_trades > 0 && (
            <span className="text-[10px] text-muted-foreground">±{ci.toFixed(1)}%</span>
          )}
        </div>
      </TableCell>
      <TableCell className="text-right tabular-nums">
        <div className="flex flex-col items-end">
          <span>{m.total_trades}</span>
          {lowSample && (
            <Badge variant="outline" className="text-[10px] mt-0.5 border-amber-500/40 text-amber-600">
              low sample
            </Badge>
          )}
        </div>
      </TableCell>
      <TableCell className="text-right">
        <FtmoBadge m={m} />
      </TableCell>
    </>
  );
}

export function PortfolioBacktestCard({
  algorithmId,
  timeframe,
}: PortfolioBacktestCardProps) {
  const intraday = isIntraday(timeframe);
  const [period, setPeriod] = useState<"compact" | "full">(intraday ? "full" : "compact");
  const [window, setWindow] = useState<Window>("all");
  const [results, setResults] = useState<BacktestMetrics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [comparison, setComparison] = useState<WindowResult[] | null>(null);
  const [isComparing, setIsComparing] = useState(false);
  const mutation = useRunPortfolioBacktest();

  function handleRun() {
    setError(null);
    setResults(null);
    setComparison(null);
    mutation.mutate(
      { id: algorithmId, period, window },
      {
        onSuccess: (r) => {
          if (r.success) setResults(r.data as BacktestMetrics);
          else setError(r.error);
        },
        onError: () => setError("Portfolio backtest failed."),
      }
    );
  }

  async function handleCompare() {
    setError(null);
    setResults(null);
    setIsComparing(true);
    const initial: WindowResult[] = COMPARE_WINDOWS.map((w) => ({
      window: w,
      metrics: null,
      loading: true,
      error: null,
    }));
    setComparison(initial);
    await Promise.all(
      COMPARE_WINDOWS.map(async (w, idx) => {
        const r = await runPortfolioBacktest(algorithmId, period, w);
        setComparison((prev) => {
          if (!prev) return prev;
          const next = [...prev];
          next[idx] = {
            window: w,
            loading: false,
            metrics: r.success ? (r.data as BacktestMetrics) : null,
            error: r.success ? null : r.error,
          };
          return next;
        });
      })
    );
    setIsComparing(false);
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
          Runs the algorithm across every watchlist ticker with a single shared capital pool. Use
          the window selector for a single date range, or Compare to see how recent vs older data
          performs side-by-side (regime drift detection).
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1.5 flex-1 min-w-[160px]">
            <Select value={window} onValueChange={(v) => setWindow(v as Window)}>
              <SelectTrigger className="w-full">
                <SelectValue>{WINDOW_LABELS[window]}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {(["all", "1y", "6m", "3m", "1m"] as const).map((w) => (
                  <SelectItem key={w} value={w}>
                    {WINDOW_LABELS[w]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5 flex-1 min-w-[160px]">
            <Select value={period} onValueChange={(v) => setPeriod(v as "compact" | "full")}>
              <SelectTrigger className="w-full">
                <SelectValue>
                  {period === "compact" ? "Compact data" : "Full history fetch"}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="compact">Compact data (last 100 bars)</SelectItem>
                <SelectItem value="full">Full history fetch</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Button onClick={handleRun} disabled={mutation.isPending || isComparing}>
            {mutation.isPending ? (
              <>
                <Loader2 className="mr-2 h-3 w-3 animate-spin" />
                Running...
              </>
            ) : (
              "Run"
            )}
          </Button>
          <Button onClick={handleCompare} disabled={mutation.isPending || isComparing} variant="outline">
            {isComparing ? (
              <>
                <Loader2 className="mr-2 h-3 w-3 animate-spin" />
                Comparing...
              </>
            ) : (
              "Compare windows"
            )}
          </Button>
        </div>
        {error && <p className="text-xs text-[var(--loss)]">{error}</p>}
        {comparison && <ComparisonTable rows={comparison} />}
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
