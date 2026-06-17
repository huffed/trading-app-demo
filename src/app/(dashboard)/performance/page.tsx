"use client";

import { AlertCircle, TrendingUp } from "lucide-react";
import { StrategyMatrixTable } from "@/components/performance/strategy-matrix-table";
import {
  ReturnsByStrategyChart,
  ReturnsByTickerChart,
} from "@/components/performance/strategy-totals-chart";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useStrategyMatrix } from "@/hooks/use-strategy-matrix";

export default function PerformancePage() {
  const { data, isLoading, isError, error } = useStrategyMatrix();

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Performance</h1>
        <p className="text-sm text-muted-foreground">
          Backtest returns across every deployed strategy × ticker × timeframe. Use to spot the
          workhorses, the tail, and concentration risk on any one instrument.
        </p>
      </div>

      {isLoading && (
        <div className="space-y-4">
          <div className="grid gap-4 lg:grid-cols-2">
            <Skeleton className="h-[280px] rounded-lg" />
            <Skeleton className="h-[280px] rounded-lg" />
          </div>
          <Skeleton className="h-[300px] rounded-lg" />
        </div>
      )}

      {isError && (
        <Card>
          <CardContent className="p-4 flex items-start gap-3 text-sm">
            <AlertCircle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
            <div>
              <p className="font-medium">Failed to load performance matrix</p>
              <p className="text-muted-foreground mt-1">
                {error instanceof Error ? error.message : "Unknown error"}
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {data && !isLoading && (
        <>
          <SummaryStrip rows={data} />
          <div className="grid gap-4 lg:grid-cols-2">
            <ReturnsByTickerChart rows={data} />
            <ReturnsByStrategyChart rows={data} />
          </div>
          <StrategyMatrixTable rows={data} />
        </>
      )}
    </div>
  );
}

function SummaryStrip({
  rows,
}: {
  rows: { total_return: number | null; status: string }[];
}) {
  const live = rows.filter((r) => r.status === "LIVE").length;
  const paper = rows.filter((r) => r.status === "paper").length;
  const withBacktest = rows.filter((r) => r.total_return != null).length;
  const totalLibrary = rows.reduce((s, r) => s + (r.total_return ?? 0), 0);

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <SummaryCard label="Total algos" value={String(rows.length)} hint={`${withBacktest} have backtest data`} />
      <SummaryCard label="Live" value={String(live)} hint="Broker-mirroring on" />
      <SummaryCard label="Paper" value={String(paper)} hint="Scanning but not mirroring" />
      <SummaryCard
        label="Library total $"
        value={fmtCurrency(totalLibrary)}
        hint="Summed 6yr backtest return"
        icon={<TrendingUp className="h-3.5 w-3.5" />}
        emphasis
      />
    </div>
  );
}

function SummaryCard({
  label,
  value,
  hint,
  icon,
  emphasis = false,
}: {
  label: string;
  value: string;
  hint?: string;
  icon?: React.ReactNode;
  emphasis?: boolean;
}) {
  return (
    <Card className={emphasis ? "border-primary/50" : undefined}>
      <CardContent className="p-4 space-y-1.5">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {icon}
          {label}
        </div>
        <p className="text-2xl font-semibold">{value}</p>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </CardContent>
    </Card>
  );
}

function fmtCurrency(value: number): string {
  const sign = value < 0 ? "-" : "";
  return `${sign}$${Math.abs(value).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}
