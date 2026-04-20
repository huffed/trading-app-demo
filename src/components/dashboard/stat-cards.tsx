"use client";

import { Activity, BarChart3, Target, TrendingUp } from "lucide-react";
import { ContextualTip } from "@/components/onboarding/contextual-tip";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useDashboardStats } from "@/hooks/use-dashboard-stats";
import { formatPnl, pnlColorClass } from "@/lib/utils/pnl";

interface StatCardProps {
  title: string;
  tipId: string;
  tipValue?: string;
  value: string;
  icon: React.ReactNode;
  valueClass?: string;
}

function StatCard({ title, tipId, tipValue, value, icon, valueClass }: StatCardProps) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-1.5">
          {title}
          <ContextualTip tipId={tipId} personalizedValue={tipValue} />
        </CardTitle>
        {icon}
      </CardHeader>
      <CardContent>
        <p className={`text-2xl font-bold ${valueClass ?? ""}`}>{value}</p>
      </CardContent>
    </Card>
  );
}

function StatCardSkeleton() {
  return (
    <Card>
      <CardHeader className="pb-2">
        <Skeleton className="h-4 w-24" />
      </CardHeader>
      <CardContent>
        <Skeleton className="h-8 w-20" />
      </CardContent>
    </Card>
  );
}

export function StatCards() {
  const { data, isLoading } = useDashboardStats();

  if (isLoading) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <StatCardSkeleton key={i} />
        ))}
      </div>
    );
  }

  const stats = data?.stats;
  const iconClass = "h-4 w-4 text-muted-foreground";

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <StatCard
        title="Total P&L"
        tipId="total-pnl"
        tipValue={stats ? formatPnl(stats.totalPnl) : undefined}
        value={stats ? formatPnl(stats.totalPnl) : "$0.00"}
        icon={<TrendingUp className={iconClass} />}
        valueClass={stats ? pnlColorClass(stats.totalPnl) : undefined}
      />
      <StatCard
        title="Win Rate"
        tipId="win-rate"
        tipValue={stats ? `${stats.winRate.toFixed(1)}%` : undefined}
        value={stats ? `${stats.winRate.toFixed(1)}%` : "0%"}
        icon={<Target className={iconClass} />}
      />
      <StatCard
        title="Open Positions"
        tipId="open-positions"
        tipValue={stats ? stats.openTrades.toString() : undefined}
        value={stats ? stats.openTrades.toString() : "0"}
        icon={<Activity className={iconClass} />}
      />
      <StatCard
        title="Total Trades"
        tipId="total-trades"
        tipValue={stats ? stats.totalTrades.toString() : undefined}
        value={stats ? stats.totalTrades.toString() : "0"}
        icon={<BarChart3 className={iconClass} />}
      />
    </div>
  );
}
