"use client";

import { BarChart3, Calendar, Flame, Target, TrendingUp, Trophy } from "lucide-react";
import { ContextualTip } from "@/components/onboarding/contextual-tip";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useDashboardStats } from "@/hooks/use-dashboard-stats";
import { formatPnl, pnlColorClass } from "@/lib/utils/pnl";

interface StatCardProps {
  title: string;
  tipId?: string;
  value: string;
  icon: React.ReactNode;
  valueClass?: string;
  subtitle?: string;
}

function StatCard({ title, tipId, value, icon, valueClass, subtitle }: StatCardProps) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-1.5">
          {title}
          {tipId && <ContextualTip tipId={tipId} />}
        </CardTitle>
        {icon}
      </CardHeader>
      <CardContent>
        <p className={`text-2xl font-bold ${valueClass ?? ""}`}>{value}</p>
        {subtitle && <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>}
      </CardContent>
    </Card>
  );
}

function formatStreak(streak: number): { value: string; subtitle: string; className: string } {
  if (streak === 0) {
    return { value: "—", subtitle: "No trades yet", className: "" };
  }
  const abs = Math.abs(streak);
  if (streak > 0) {
    return {
      value: `${abs}W`,
      subtitle: `${abs} win${abs > 1 ? "s" : ""} in a row`,
      className: "text-[var(--profit)]",
    };
  }
  return {
    value: `${abs}L`,
    subtitle: `${abs} loss${abs > 1 ? "es" : ""} in a row`,
    className: "text-[var(--loss)]",
  };
}

export function StatCards() {
  const { data, isLoading } = useDashboardStats();

  if (isLoading) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <Card key={i}>
            <CardHeader className="pb-2">
              <Skeleton className="h-4 w-20" />
            </CardHeader>
            <CardContent>
              <Skeleton className="h-8 w-16" />
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  const stats = data?.stats;
  const ic = "h-4 w-4 text-muted-foreground";
  const streak = formatStreak(stats?.streak ?? 0);

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
      <StatCard
        title="Total P&L"
        tipId="total-pnl"
        value={stats ? formatPnl(stats.totalPnl) : "$0.00"}
        icon={<TrendingUp className={ic} />}
        valueClass={stats ? pnlColorClass(stats.totalPnl) : undefined}
      />
      <StatCard
        title="Today"
        value={stats ? formatPnl(stats.todayPnl) : "$0.00"}
        icon={<Calendar className={ic} />}
        valueClass={stats ? pnlColorClass(stats.todayPnl) : undefined}
      />
      <StatCard
        title="Win Rate"
        tipId="win-rate"
        value={stats ? `${stats.winRate.toFixed(1)}%` : "0%"}
        icon={<Target className={ic} />}
        subtitle={stats ? `${stats.closedTrades} closed trades` : undefined}
      />
      <StatCard
        title="Streak"
        value={streak.value}
        icon={<Flame className={ic} />}
        valueClass={streak.className}
        subtitle={streak.subtitle}
      />
      <StatCard
        title="Best Trade"
        value={stats ? formatPnl(stats.bestTrade) : "$0.00"}
        icon={<Trophy className={ic} />}
        valueClass={stats ? pnlColorClass(stats.bestTrade) : undefined}
      />
      <StatCard
        title="Worst Trade"
        value={stats ? formatPnl(stats.worstTrade) : "$0.00"}
        icon={<BarChart3 className={ic} />}
        valueClass={stats ? pnlColorClass(stats.worstTrade) : undefined}
      />
    </div>
  );
}
