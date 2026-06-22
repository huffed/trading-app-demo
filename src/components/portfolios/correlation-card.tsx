"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, GitCompareArrows } from "lucide-react";
import {
  CORRELATION_HIGH_THRESHOLD,
  CORRELATION_MIN_PAIRED_DAYS,
  type PortfolioCorrelationResult,
  getPortfolioCorrelation,
} from "@/app/(dashboard)/portfolios/correlation-actions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

interface CorrelationCardProps {
  portfolioId: string;
  portfolioName: string;
}

function correlationTone(r: number): string {
  if (r >= CORRELATION_HIGH_THRESHOLD) return "text-[var(--loss)] font-medium";
  if (r <= -CORRELATION_HIGH_THRESHOLD) return "text-[var(--profit)] font-medium";
  if (Math.abs(r) >= 0.4) return "text-amber-600";
  return "text-muted-foreground";
}

function lookupName(id: string, algos: PortfolioCorrelationResult["algorithms"]): string {
  return algos.find((a) => a.id === id)?.name ?? id.slice(0, 8);
}

function HighCorrelationWarnings({ data }: { data: PortfolioCorrelationResult }) {
  if (data.high_correlation_pairs.length === 0) return null;
  return (
    <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-2.5 text-xs">
      <div className="flex items-center gap-1.5 font-medium text-amber-600">
        <AlertTriangle className="h-3.5 w-3.5" />
        Concentration risk — {data.high_correlation_pairs.length} pair
        {data.high_correlation_pairs.length === 1 ? "" : "s"} above ±
        {CORRELATION_HIGH_THRESHOLD.toFixed(1)}
      </div>
      <ul className="mt-1.5 space-y-0.5 text-muted-foreground">
        {data.high_correlation_pairs.map((c) => (
          <li key={`${c.algorithm_a}-${c.algorithm_b}`} className="flex justify-between gap-3">
            <span className="truncate">
              {lookupName(c.algorithm_a, data.algorithms)} ↔{" "}
              {lookupName(c.algorithm_b, data.algorithms)}
            </span>
            <span className="tabular-nums shrink-0">
              {(c.correlation ?? 0).toFixed(2)} · {c.paired_days}d
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function CellsTable({ data }: { data: PortfolioCorrelationResult }) {
  return (
    <div className="space-y-1 text-xs">
      <p className="text-muted-foreground">
        Pearson correlation of daily P&amp;L across the last {data.lookback_days} days.
        Cells with fewer than {CORRELATION_MIN_PAIRED_DAYS} overlapping days show ‘insufficient
        data’ — algos need overlapping closed-trade history to produce a meaningful number.
      </p>
      <div className="space-y-0.5">
        {data.cells.map((c) => (
          <div
            key={`${c.algorithm_a}-${c.algorithm_b}`}
            className="flex items-center justify-between border-b py-1"
          >
            <span className="truncate">
              <span className="font-medium">{lookupName(c.algorithm_a, data.algorithms)}</span>
              <span className="text-muted-foreground"> vs </span>
              <span className="font-medium">{lookupName(c.algorithm_b, data.algorithms)}</span>
            </span>
            <span className="tabular-nums shrink-0 ml-2">
              {c.correlation === null ? (
                <span className="text-muted-foreground">insufficient data ({c.paired_days}d)</span>
              ) : (
                <span className={correlationTone(c.correlation)}>
                  {c.correlation >= 0 ? "+" : ""}
                  {c.correlation.toFixed(2)}{" "}
                  <span className="text-[10px] text-muted-foreground">· {c.paired_days}d</span>
                </span>
              )}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function CorrelationCard({ portfolioId, portfolioName }: CorrelationCardProps) {
  const [data, setData] = useState<PortfolioCorrelationResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    getPortfolioCorrelation(portfolioId).then((r) => {
      if (r.success) setData(r.data);
      else setError(r.error);
      setIsLoading(false);
    });
  }, [portfolioId]);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium flex items-center gap-1.5">
          <GitCompareArrows className="h-4 w-4" />
          {portfolioName} · cross-algo correlation
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading && <Skeleton className="h-20 w-full" />}
        {error && <p className="text-xs text-[var(--loss)]">{error}</p>}
        {!isLoading && !error && data && data.algorithms.length < 2 && (
          <p className="text-xs text-muted-foreground">
            Correlation analysis requires 2 or more algorithms in this portfolio. Currently:{" "}
            {data.algorithms.length}.
          </p>
        )}
        {!isLoading && !error && data && data.algorithms.length >= 2 && (
          <>
            <HighCorrelationWarnings data={data} />
            <CellsTable data={data} />
          </>
        )}
      </CardContent>
    </Card>
  );
}
