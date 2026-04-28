"use client";

import { TrendingUp } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useClosedPositionsWindow } from "@/hooks/use-paper-trading";
import { formatPnl, pnlColorClass } from "@/lib/utils/pnl";
import { EquityCurveChart } from "./equity-curve-chart";

interface AlgoEquityCurveCardProps {
  algorithmId: string;
  days?: number;
}

function CurveBody({
  isLoading,
  chartData,
  tradeCount,
  days,
}: {
  isLoading: boolean;
  chartData: { date: string; value: number }[];
  tradeCount: number;
  days: number;
}) {
  if (isLoading) return <Skeleton className="h-44 w-full" />;
  if (chartData.length < 2) {
    return (
      <p className="text-xs text-muted-foreground py-6 text-center">
        Need at least 2 closed paper trades in the last {days} days to plot a curve.
        {tradeCount === 1 && ` Found 1 — waiting for the next close.`}
      </p>
    );
  }
  return <EquityCurveChart data={chartData} />;
}

/**
 * Per-algorithm cumulative-pnl curve from paper-mode closed positions.
 * Chart anchors at 0 on the first close in the window so the curve
 * shows pnl-since-start, not equity-since-account-open — operator wants
 * "is this algo gaining ground in the last 30 days?", not the absolute
 * level. Empty / single-trade windows render an explanatory placeholder
 * instead of a misleading flat line.
 */
export function AlgoEquityCurveCard({ algorithmId, days = 30 }: AlgoEquityCurveCardProps) {
  const { data: positions = [], isLoading } = useClosedPositionsWindow(algorithmId, days);

  const chartData = positions
    .filter((p) => p.closed_at && p.realized_pnl != null)
    .reduce<{ date: string; value: number }[]>((acc, p) => {
      const prev = acc.length > 0 ? acc[acc.length - 1].value : 0;
      const closedAt = p.closed_at as string;
      acc.push({ date: closedAt.slice(5, 10), value: prev + (p.realized_pnl ?? 0) });
      return acc;
    }, []);

  const totalPnl = chartData.length > 0 ? chartData[chartData.length - 1].value : 0;
  const tradeCount = chartData.length;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center justify-between text-base">
          <span className="flex items-center gap-1.5">
            <TrendingUp className="h-4 w-4" />
            Cumulative P&amp;L · last {days} days
          </span>
          {tradeCount > 0 && (
            <span className={`text-sm tabular-nums ${pnlColorClass(totalPnl)}`}>
              {formatPnl(totalPnl)}
              <span className="ml-1.5 text-xs text-muted-foreground">
                · {tradeCount} trade{tradeCount === 1 ? "" : "s"}
              </span>
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <CurveBody
          isLoading={isLoading}
          chartData={chartData}
          tradeCount={tradeCount}
          days={days}
        />
      </CardContent>
    </Card>
  );
}
