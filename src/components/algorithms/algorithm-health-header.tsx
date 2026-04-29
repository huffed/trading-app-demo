"use client";

import { useEffect, useState } from "react";
import { Activity, AlertTriangle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  useClosedPositions,
  useOpenPositions,
} from "@/hooks/use-paper-trading";
import { formatPnl, formatRelativeTime, pnlColorClass } from "@/lib/utils/pnl";

function StatusBadges({
  status,
  liveTradingEnabled,
}: {
  status: string;
  liveTradingEnabled: boolean;
}) {
  const isHealthy = status === "active";
  return (
    <div className="flex items-center gap-1.5">
      <Activity className="h-4 w-4 text-muted-foreground" />
      <Badge
        variant={isHealthy ? "default" : "secondary"}
        className="capitalize text-[11px]"
      >
        {status}
      </Badge>
      {liveTradingEnabled ? (
        <Badge variant="default" className="text-[11px]">
          Live
        </Badge>
      ) : (
        <Badge variant="outline" className="text-[11px]">
          Paper
        </Badge>
      )}
    </div>
  );
}

/**
 * At-a-glance summary for an algorithm. Shows:
 *   - Status + live-trading flag
 *   - Open / closed-today counts
 *   - Aggregate today's P&L (closed + unrealized open)
 *   - Last activity timestamp
 *
 * Sits above the open-positions list on the Paper Trading tab. Designed
 * to answer "is the system OK?" in <5 seconds, before the operator
 * drills into individual positions.
 */
export function AlgorithmHealthHeader({
  algorithmId,
  algorithmStatus,
  liveTradingEnabled,
  lastScannedAt,
}: {
  algorithmId: string;
  algorithmStatus: string;
  liveTradingEnabled: boolean;
  lastScannedAt: string | null;
}) {
  const { data: openPositions } = useOpenPositions(algorithmId);
  const { data: closed } = useClosedPositions(algorithmId, 1, 100);

  const openCount = openPositions?.length ?? 0;
  const unrealizedTotal = (openPositions ?? []).reduce(
    (s, p) => s + (p.broker_unrealized_pnl ?? p.unrealized_pnl ?? 0),
    0
  );

  // Closed in the last 24h. Lazy initial state for Date.now() (one-shot,
  // satisfies React 19 compiler purity). Refreshed every 60s in an
  // effect — finer granularity isn't useful for daily review.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  const closedRecent = (closed?.positions ?? []).filter(
    (p) => p.closed_at && new Date(p.closed_at).getTime() >= nowMs - 24 * 60 * 60 * 1000
  );
  const realizedRecent = closedRecent.reduce(
    (s, p) => s + (p.realized_pnl ?? 0),
    0
  );
  const todayTotal = unrealizedTotal + realizedRecent;

  return (
    <Card>
      <CardContent className="flex flex-wrap items-center gap-4 py-3">
        <StatusBadges status={algorithmStatus} liveTradingEnabled={liveTradingEnabled} />
        <div className="flex items-baseline gap-1.5">
          <span className="text-xs text-muted-foreground">Open</span>
          <span className="text-sm font-medium tabular-nums">{openCount}</span>
        </div>
        <div className="flex items-baseline gap-1.5">
          <span className="text-xs text-muted-foreground">Closed (24h)</span>
          <span className="text-sm font-medium tabular-nums">{closedRecent.length}</span>
        </div>
        <div className="flex items-baseline gap-1.5">
          <span className="text-xs text-muted-foreground">Today P&L</span>
          <span className={`text-sm font-medium tabular-nums ${pnlColorClass(todayTotal)}`}>
            {formatPnl(todayTotal)}
          </span>
          <span className="text-[11px] text-muted-foreground">
            (open {formatPnl(unrealizedTotal)} · closed {formatPnl(realizedRecent)})
          </span>
        </div>
        <div className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
          {lastScannedAt ? (
            <>
              <span>Last scan</span>
              <span className="tabular-nums">{formatRelativeTime(lastScannedAt)}</span>
            </>
          ) : (
            <>
              <AlertTriangle className="h-3 w-3" />
              <span>Never scanned</span>
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
