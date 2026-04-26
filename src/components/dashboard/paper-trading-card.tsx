"use client";

import { useState } from "react";
import Link from "next/link";
import { Activity, Bot, Loader2, Play, TrendingUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useAutoRefreshPrices,
  usePaperTradingStats,
  useTriggerScan,
} from "@/hooks/use-paper-trading";
import { EXIT_REASON_LABELS } from "@/lib/constants/algorithm";
import type { ScanResult } from "@/lib/scan/engine";
import { formatCurrency, formatPnl, formatRelativeTime, pnlColorClass } from "@/lib/utils/pnl";

function EmptyState() {
  return (
    <Card>
      <CardContent className="flex items-center justify-between p-4">
        <div className="flex items-center gap-3">
          <Bot className="h-5 w-5 text-muted-foreground" />
          <div>
            <p className="text-sm font-medium">Paper Trading</p>
            <p className="text-xs text-muted-foreground">
              Set an algorithm to &ldquo;Active&rdquo; to start paper trading.
            </p>
          </div>
        </div>
        <Button
          size="sm"
          variant="outline"
          render={<Link href="/algorithms" />}
          nativeButton={false}
        >
          View Algorithms
        </Button>
      </CardContent>
    </Card>
  );
}

function DashboardScanSummary({ results }: { results: ScanResult[] }) {
  if (results.length === 0) {
    return null;
  }

  const allOpened = results.flatMap((r) => r.opened_details);
  const allClosed = results.flatMap((r) => r.closed_details);
  const noAction = allOpened.length === 0 && allClosed.length === 0;

  if (noAction) {
    return <p className="mt-3 text-xs text-muted-foreground">Scan complete — no signals fired</p>;
  }

  return (
    <div className="mt-3 space-y-1 text-xs">
      {allOpened.map((e, i) => (
        <p key={`o-${i}`} className="text-[var(--profit)]">
          &#9650; Opened <strong>{e.ticker}</strong> at {formatCurrency(e.price)}
        </p>
      ))}
      {allClosed.map((e, i) => (
        <p key={`c-${i}`}>
          &#9660; Closed <strong>{e.ticker}</strong>{" "}
          <span className={pnlColorClass(e.pnl)}>{formatPnl(e.pnl)}</span>{" "}
          <span className="text-muted-foreground">
            ({EXIT_REASON_LABELS[e.reason] ?? e.reason})
          </span>
        </p>
      ))}
    </div>
  );
}

function StatsGrid({
  stats,
}: {
  stats: {
    active_algorithms: number;
    open_positions: number;
    total_unrealized_pnl: number;
    total_realized_pnl: number;
    last_scan_at: string | null;
  };
}) {
  return (
    <>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <div>
          <p className="text-xs text-muted-foreground">Active Algorithms</p>
          <p className="text-xl font-bold">{stats.active_algorithms}</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Open Positions</p>
          <p className="text-xl font-bold flex items-center gap-1.5">
            <TrendingUp className="h-4 w-4 text-muted-foreground" />
            {stats.open_positions}
          </p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Unrealized P&L</p>
          <p className={`text-xl font-bold ${pnlColorClass(stats.total_unrealized_pnl)}`}>
            {formatPnl(stats.total_unrealized_pnl)}
          </p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Realized P&L</p>
          <p className={`text-xl font-bold ${pnlColorClass(stats.total_realized_pnl)}`}>
            {formatPnl(stats.total_realized_pnl)}
          </p>
        </div>
      </div>
      {stats.last_scan_at && (
        <p className="mt-3 text-xs text-muted-foreground flex items-center gap-1">
          <Activity className="h-3 w-3" />
          Last scan {formatRelativeTime(stats.last_scan_at)}
        </p>
      )}
    </>
  );
}

export function PaperTradingCard() {
  const { data: stats, isLoading } = usePaperTradingStats();
  const scanMutation = useTriggerScan();
  const [scanResults, setScanResults] = useState<ScanResult[] | null>(null);
  useAutoRefreshPrices(undefined, !!stats && stats.open_positions > 0);

  if (isLoading) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <Skeleton className="h-4 w-32" />
        </CardHeader>
        <CardContent>
          <Skeleton className="h-16 w-full" />
        </CardContent>
      </Card>
    );
  }

  if (!stats || stats.active_algorithms === 0) {
    return <EmptyState />;
  }

  function handleScan() {
    setScanResults(null);
    scanMutation.mutate(undefined, {
      onSuccess: (result) => {
        if (result.success) {
          setScanResults(result.data);
        }
      },
    });
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-1.5">
          <Bot className="h-4 w-4" />
          Paper Trading
        </CardTitle>
        <Button size="sm" onClick={handleScan} disabled={scanMutation.isPending}>
          {scanMutation.isPending ? (
            <>
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              Scanning...
            </>
          ) : (
            <>
              <Play className="mr-1.5 h-3.5 w-3.5" />
              Scan All
            </>
          )}
        </Button>
      </CardHeader>
      <CardContent>
        <StatsGrid stats={stats} />
        {scanResults && <DashboardScanSummary results={scanResults} />}
      </CardContent>
    </Card>
  );
}
