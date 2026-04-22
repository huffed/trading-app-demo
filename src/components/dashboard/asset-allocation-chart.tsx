"use client";

import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { ContextualTip } from "@/components/onboarding/contextual-tip";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useDashboardStats } from "@/hooks/use-dashboard-stats";
import { ASSET_CLASS_LABELS } from "@/lib/constants/algorithm";
import type { Trade } from "@/types/trade";

const COLORS = [
  "var(--color-chart-1)",
  "var(--color-chart-2)",
  "var(--color-chart-3)",
  "var(--color-chart-4)",
  "var(--color-chart-5)",
];


function computeAllocation(trades: Trade[]) {
  const counts: Record<string, number> = {};
  for (const t of trades) {
    counts[t.asset_class] = (counts[t.asset_class] ?? 0) + 1;
  }
  return Object.entries(counts).map(([name, value]) => ({
    name: ASSET_CLASS_LABELS[name] ?? name,
    value,
  }));
}

function AllocationLegend({ data }: { data: { name: string; value: number }[] }) {
  const total = data.reduce((s, d) => s + d.value, 0);
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2">
      {data.map((d, i) => (
        <div key={d.name} className="flex items-center gap-1.5 text-xs">
          <span
            className="inline-block h-2.5 w-2.5 rounded-full"
            style={{ backgroundColor: COLORS[i % COLORS.length] }}
          />
          <span className="text-muted-foreground">
            {d.name} ({((d.value / total) * 100).toFixed(0)}%)
          </span>
        </div>
      ))}
    </div>
  );
}

export function AssetAllocationChart() {
  const { data, isLoading } = useDashboardStats();

  const allocation = data ? computeAllocation(data.trades) : [];

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium flex items-center gap-1.5">
          Asset Allocation
          <ContextualTip tipId="asset-allocation" />
        </CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading && <Skeleton className="h-48 w-full" />}
        {!isLoading && allocation.length === 0 && (
          <div className="flex items-center justify-center h-48">
            <p className="text-sm text-muted-foreground">Add trades to see allocation</p>
          </div>
        )}
        {!isLoading && allocation.length > 0 && (
          <>
            <ResponsiveContainer width="100%" height={180}>
              <PieChart>
                <Pie
                  data={allocation}
                  cx="50%"
                  cy="50%"
                  innerRadius={50}
                  outerRadius={75}
                  dataKey="value"
                  strokeWidth={2}
                  stroke="var(--color-background)"
                >
                  {allocation.map((_, i) => (
                    <Cell key={i} fill={COLORS[i % COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={{
                    backgroundColor: "var(--color-popover)",
                    border: "1px solid var(--color-border)",
                    borderRadius: "8px",
                    fontSize: 12,
                    color: "var(--color-popover-foreground)",
                  }}
                  formatter={(value, name) => [`${value} trades`, name]}
                />
              </PieChart>
            </ResponsiveContainer>
            <AllocationLegend data={allocation} />
          </>
        )}
      </CardContent>
    </Card>
  );
}
