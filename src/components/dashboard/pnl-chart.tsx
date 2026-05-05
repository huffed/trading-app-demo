"use client";

import { useMemo } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useDashboardStats } from "@/hooks/use-dashboard-stats";
import { computeEquityCurve } from "@/lib/utils/equity-curve";
import { formatCurrency } from "@/lib/utils/pnl";
import type { Trade } from "@/types/trade";

function ChartEmpty() {
  return (
    <div className="flex items-center justify-center h-48">
      <p className="text-sm text-muted-foreground">Close your first trade to see P&L trends</p>
    </div>
  );
}

function PnlAreaChart({ data }: { data: { date: string; value: number }[] }) {
  return (
    <ResponsiveContainer width="100%" height={200}>
      <AreaChart data={data} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
        <defs>
          <linearGradient id="pnlGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="var(--color-chart-1)" stopOpacity={0.3} />
            <stop offset="95%" stopColor="var(--color-chart-1)" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
        <XAxis
          dataKey="date"
          tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }}
          axisLine={false}
          tickLine={false}
        />
        <YAxis
          tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }}
          axisLine={false}
          tickLine={false}
          tickFormatter={(v: number) => formatCurrency(v)}
        />
        <Tooltip
          contentStyle={{
            backgroundColor: "var(--color-popover)",
            border: "1px solid var(--color-border)",
            borderRadius: "8px",
            fontSize: 12,
            color: "var(--color-popover-foreground)",
          }}
          formatter={(value) => [formatCurrency(Number(value)), "P&L"]}
        />
        <Area
          type="monotone"
          dataKey="value"
          stroke="var(--color-chart-1)"
          fill="url(#pnlGradient)"
          strokeWidth={2}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

function PnlContent({ trades }: { trades: Trade[] }) {
  const chartData = useMemo(
    () =>
      computeEquityCurve(
        trades
          .filter((t) => t.status === "closed")
          .map((t) => ({
            realized_pnl: t.realized_pnl ?? 0,
            closed_at: t.exit_date ?? "",
          }))
      ),
    [trades]
  );
  if (chartData.length === 0) return <ChartEmpty />;
  return <PnlAreaChart data={chartData} />;
}

export function PnlChart() {
  const { data, isLoading } = useDashboardStats();

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">P&L Over Time</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading && <Skeleton className="h-48 w-full" />}
        {!isLoading && data && <PnlContent trades={data.trades} />}
      </CardContent>
    </Card>
  );
}
