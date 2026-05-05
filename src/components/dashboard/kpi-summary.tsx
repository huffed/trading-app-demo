"use client";

/**
 * Top-of-dashboard KPI strip — portfolio-wide paper-trading aggregates.
 * Reads `usePaperTradingStats()` (the canonical source) plus a 7-day
 * realized-pnl slice for the "this week" cell. The 30d realized total
 * isn't a separate query — derived from the same closed-positions data
 * that powers the equity hero.
 */
import { useMemo } from "react";
import { KpiStrip } from "@/components/layout/kpi-strip";
import { Skeleton } from "@/components/ui/skeleton";
import { Stat } from "@/components/ui/stat";
import { Surface } from "@/components/ui/surface";
import {
  useClosedPositionsWindow,
  usePaperTradingStats,
} from "@/hooks/use-paper-trading";
import { formatPnl, formatRelativeTime } from "@/lib/utils/pnl";

const DAY_MS = 86_400_000;

interface ClosedRow {
  realized_pnl: number | null;
  closed_at: string | null;
}

function pnlState(value: number): "profit" | "loss" | "neutral" {
  if (value > 0) return "profit";
  if (value < 0) return "loss";
  return "neutral";
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

function summarise(closed: ClosedRow[]) {
  const now = Date.now();
  const dayCutoff = now - DAY_MS;
  const weekCutoff = now - 7 * DAY_MS;
  let today = 0;
  let todayCount = 0;
  let week = 0;
  for (const p of closed) {
    if (!p.closed_at) continue;
    const t = new Date(p.closed_at).getTime();
    const pnl = p.realized_pnl ?? 0;
    if (t >= weekCutoff) week += pnl;
    if (t >= dayCutoff) {
      today += pnl;
      todayCount++;
    }
  }
  return { today, todayCount, week };
}

export function KpiSummary() {
  const { data: stats, isLoading: statsLoading } = usePaperTradingStats();
  const { data: closed = [], isLoading: closedLoading } = useClosedPositionsWindow(undefined, 30);
  const summary = useMemo(() => summarise(closed), [closed]);

  if (statsLoading || closedLoading) return <LoadingStrip />;

  const lastScan = stats?.last_scan_at;

  return (
    <KpiStrip>
      <Stat
        label="Today"
        value={formatPnl(summary.today)}
        delta={`${summary.todayCount} closes`}
        state={pnlState(summary.today)}
      />
      <Stat
        label="Open positions"
        value={stats?.open_positions ?? 0}
        delta={
          stats && stats.total_unrealized_pnl !== 0
            ? `${formatPnl(stats.total_unrealized_pnl)} unrealized`
            : "—"
        }
      />
      <Stat
        label="7d realized"
        value={formatPnl(summary.week)}
        state={pnlState(summary.week)}
      />
      <Stat
        label="Active algorithms"
        value={stats?.active_algorithms ?? 0}
        delta={lastScan ? `last scan ${formatRelativeTime(lastScan)}` : "no scans yet"}
      />
    </KpiStrip>
  );
}
