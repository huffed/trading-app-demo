"use client";

/**
 * Per-algorithm hero equity curve — 30-day cumulative pnl from closed
 * paper positions for one algorithm. Glass surface presentation;
 * replaces the old `AlgoEquityCurveCard`. Cumulative reduction lives
 * in `lib/utils/equity-curve` — broker-truth filter stays here because
 * it's display-layer (broker_close_price fallback to realized_pnl).
 */
import { useMemo } from "react";
import { TrendingUp } from "lucide-react";
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Surface } from "@/components/ui/surface";
import { useClosedPositionsWindow } from "@/hooks/use-paper-trading";
import { computeEquityCurve } from "@/lib/utils/equity-curve";
import { displayedPnl, formatCurrency, formatPnl, pnlColorClass } from "@/lib/utils/pnl";
import type { PaperPosition } from "@/types/position";

function buildCurve(positions: PaperPosition[]): { date: string; value: number }[] {
  // Broker-truth cumulative — uses broker fill/close prices when set,
  // falls back to system realized_pnl otherwise. Mirrors FTMO dashboard.
  return computeEquityCurve(
    positions
      .filter((p) => p.closed_at && (p.realized_pnl != null || p.broker_close_price != null))
      .map((p) => ({ realized_pnl: displayedPnl(p) ?? 0, closed_at: p.closed_at! }))
  );
}

const TOOLTIP_STYLE = {
  backgroundColor: "var(--color-popover)",
  border: "1px solid var(--glass-border-strong)",
  borderRadius: "8px",
  fontSize: 12,
  color: "var(--color-popover-foreground)",
};

export function AlgoEquityHero({ algorithmId, days = 30 }: { algorithmId: string; days?: number }) {
  const { data: positions = [], isLoading } = useClosedPositionsWindow(algorithmId, days);
  const curve = useMemo(() => buildCurve(positions), [positions]);
  const total = curve.length > 0 ? curve[curve.length - 1].value : 0;
  const tradeCount = curve.length;

  return (
    <Surface elevation="mid" className="p-5 lg:col-span-12">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <p className="text-xs uppercase tracking-wide text-muted-foreground">
            Cumulative P&amp;L · {days}d
          </p>
          {isLoading ? (
            <Skeleton className="mt-1 h-9 w-32" />
          ) : (
            <p
              className={`mt-1 font-mono text-3xl font-semibold tabular-nums ${pnlColorClass(total)}`}
            >
              {formatPnl(total)}
            </p>
          )}
        </div>
        <Badge variant="outline" className="border-glass-border">
          <TrendingUp className="mr-1 h-3 w-3" /> {tradeCount} closes
        </Badge>
      </div>
      {isLoading && <Skeleton className="h-44 w-full" />}
      {!isLoading && curve.length < 2 && (
        <p className="py-12 text-center text-xs text-muted-foreground">
          Need at least 2 closed paper trades in the last {days} days to plot a curve.
          {tradeCount === 1 && " Found 1 — waiting for the next close."}
        </p>
      )}
      {!isLoading && curve.length >= 2 && (
        <ResponsiveContainer width="100%" height={200}>
          <AreaChart data={curve} margin={{ top: 5, right: 5, left: -10, bottom: 0 }}>
            <defs>
              <linearGradient id="algoEquityGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="var(--color-chart-1)" stopOpacity={0.4} />
                <stop offset="95%" stopColor="var(--color-chart-1)" stopOpacity={0} />
              </linearGradient>
            </defs>
            <XAxis
              dataKey="date"
              tick={{ fontSize: 10, fill: "var(--color-muted-foreground)" }}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              tick={{ fontSize: 10, fill: "var(--color-muted-foreground)" }}
              axisLine={false}
              tickLine={false}
              tickFormatter={(v: number) => formatCurrency(v)}
            />
            <Tooltip
              contentStyle={TOOLTIP_STYLE}
              formatter={(value) => [formatCurrency(Number(value)), "P&L"]}
            />
            <Area
              type="monotone"
              dataKey="value"
              stroke="var(--color-chart-1)"
              fill="url(#algoEquityGradient)"
              strokeWidth={2}
            />
          </AreaChart>
        </ResponsiveContainer>
      )}
    </Surface>
  );
}

