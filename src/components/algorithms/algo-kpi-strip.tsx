"use client";

/**
 * Per-algorithm KPI strip — today's P&L, open positions, win-rate-from-
 * backtest, last scan. Replaces the AlgorithmHealthHeader card; same
 * data, glass tile presentation matching the dashboard pattern.
 */
import { useEffect, useMemo, useState } from "react";
import { KpiStrip } from "@/components/layout/kpi-strip";
import { Skeleton } from "@/components/ui/skeleton";
import { Stat } from "@/components/ui/stat";
import { Surface } from "@/components/ui/surface";
import {
  useClosedPositions,
  useOpenPositions,
} from "@/hooks/use-paper-trading";
import type { BacktestMetrics } from "@/lib/market-data/types";
import { formatPnl, formatPnlPercent, formatRelativeTime } from "@/lib/utils/pnl";

const DAY_MS = 86_400_000;

function pnlState(value: number): "profit" | "loss" | "neutral" {
  if (value > 0) return "profit";
  if (value < 0) return "loss";
  return "neutral";
}

interface ClosedRow {
  realized_pnl: number | null;
  closed_at: string | null;
}

function summariseToday(closed: ClosedRow[], nowMs: number) {
  const cutoff = nowMs - DAY_MS;
  let pnl = 0;
  let count = 0;
  for (const p of closed) {
    if (!p.closed_at) continue;
    if (new Date(p.closed_at).getTime() < cutoff) continue;
    pnl += p.realized_pnl ?? 0;
    count++;
  }
  return { pnl, count };
}

function LoadingStrip() {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {Array.from({ length: 4 }).map((_, i) => (
        <Surface key={i} elevation="mid" className="p-4">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="mt-2 h-7 w-28" />
          <Skeleton className="mt-2 h-3 w-16" />
        </Surface>
      ))}
    </div>
  );
}

export function AlgoKpiStrip({
  algorithmId,
  backtestResults,
  lastScannedAt,
}: {
  algorithmId: string;
  backtestResults: BacktestMetrics | null;
  lastScannedAt: string | null;
}) {
  const { data: openPositions, isLoading: openLoading } = useOpenPositions(algorithmId);
  const { data: closedRes, isLoading: closedLoading } = useClosedPositions(algorithmId, 1, 100);

  // Lazy-init Date.now() + tick every 60s so "today" rolls over without
  // a manual refresh. React 19 compiler-friendly.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  const today = useMemo(
    () => summariseToday(closedRes?.positions ?? [], nowMs),
    [closedRes, nowMs]
  );
  const openCount = openPositions?.length ?? 0;
  const unrealized = (openPositions ?? []).reduce(
    (s, p) => s + (p.broker_unrealized_pnl ?? p.unrealized_pnl ?? 0),
    0
  );
  const todayTotal = today.pnl + unrealized;

  if (openLoading || closedLoading) return <LoadingStrip />;

  return (
    <KpiStrip>
      <Stat
        label="Today"
        value={formatPnl(todayTotal)}
        delta={`${today.count} closed · ${formatPnl(unrealized)} unrealized`}
        state={pnlState(todayTotal)}
      />
      <Stat label="Open positions" value={openCount} />
      <Stat
        label="Backtest WR"
        value={
          backtestResults && typeof backtestResults.win_rate === "number"
            ? formatPnlPercent(backtestResults.win_rate)
            : "—"
        }
        delta={
          backtestResults && typeof backtestResults.total_trades === "number"
            ? `${backtestResults.total_trades} trades`
            : undefined
        }
      />
      <Stat
        label="Last scan"
        value={lastScannedAt ? formatRelativeTime(lastScannedAt) : "never"}
      />
    </KpiStrip>
  );
}
