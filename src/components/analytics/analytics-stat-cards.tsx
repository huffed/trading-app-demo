"use client";

import { ArrowDownUp, Clock, Scale, ShieldAlert, ThumbsDown, Trophy } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { AnalyticsMetrics } from "@/lib/utils/analytics";
import { formatPnl, pnlColorClass } from "@/lib/utils/pnl";

interface StatProps {
  title: string;
  value: string;
  icon: React.ReactNode;
  valueClass?: string;
}

function StatCard({ title, value, icon, valueClass }: StatProps) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-xs font-medium text-muted-foreground">{title}</CardTitle>
        {icon}
      </CardHeader>
      <CardContent>
        <p className={`text-lg font-bold ${valueClass ?? ""}`}>{value}</p>
      </CardContent>
    </Card>
  );
}

export function AnalyticsStatCardsSkeleton() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
      {Array.from({ length: 6 }).map((_, i) => (
        <Card key={i}>
          <CardHeader className="pb-2">
            <Skeleton className="h-3 w-20" />
          </CardHeader>
          <CardContent>
            <Skeleton className="h-6 w-16" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

export function AnalyticsStatCards({ metrics }: { metrics: AnalyticsMetrics }) {
  const pf = metrics.profitFactor === Infinity ? "∞" : metrics.profitFactor.toFixed(2);
  const iconClass = "h-4 w-4 text-muted-foreground";

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
      <StatCard
        title="Profit Factor"
        value={pf}
        icon={<Scale className={iconClass} />}
        valueClass={metrics.profitFactor >= 1 ? "text-[var(--profit)]" : "text-[var(--loss)]"}
      />
      <StatCard
        title="Avg Win / Loss"
        value={`${formatPnl(metrics.avgWin)} / ${formatPnl(metrics.avgLoss)}`}
        icon={<ArrowDownUp className={iconClass} />}
      />
      <StatCard
        title="Best Trade"
        value={formatPnl(metrics.bestTrade)}
        icon={<Trophy className={iconClass} />}
        valueClass={pnlColorClass(metrics.bestTrade)}
      />
      <StatCard
        title="Worst Trade"
        value={formatPnl(metrics.worstTrade)}
        icon={<ThumbsDown className={iconClass} />}
        valueClass={pnlColorClass(metrics.worstTrade)}
      />
      <StatCard
        title="Max Drawdown"
        value={`${metrics.maxDrawdownPercent.toFixed(1)}%`}
        icon={<ShieldAlert className={iconClass} />}
        valueClass="text-[var(--loss)]"
      />
      <StatCard
        title="Avg Duration"
        value={`${metrics.avgDurationDays}d`}
        icon={<Clock className={iconClass} />}
      />
    </div>
  );
}
