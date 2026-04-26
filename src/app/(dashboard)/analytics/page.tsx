"use client";

import {
  AnalyticsStatCards,
  AnalyticsStatCardsSkeleton,
} from "@/components/analytics/analytics-stat-cards";
import { DayOfWeekCard } from "@/components/analytics/day-of-week-card";
import { DistributionCard } from "@/components/analytics/distribution-card";
import { DrawdownCard } from "@/components/analytics/drawdown-card";
import { EquityCurveCard } from "@/components/analytics/equity-curve-card";
import { MonthlyReturnsCard } from "@/components/analytics/monthly-returns-card";
import { SymbolPerformanceCard } from "@/components/analytics/symbol-performance-card";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAnalytics, type DataSource } from "@/hooks/use-analytics";

function ChartSkeleton() {
  return (
    <Card>
      <CardContent className="p-4">
        <Skeleton className="h-[250px] w-full" />
      </CardContent>
    </Card>
  );
}

function EmptyState() {
  return (
    <Card>
      <CardContent className="flex items-center justify-center p-12">
        <p className="text-sm text-muted-foreground">
          No closed trades to analyze. Close some trades or run paper trading scans to see your
          performance.
        </p>
      </CardContent>
    </Card>
  );
}

export default function AnalyticsPage() {
  const analytics = useAnalytics();

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Analytics</h1>
          <p className="text-sm text-muted-foreground">
            Performance metrics and trading statistics.
          </p>
        </div>
        <Tabs defaultValue="all" onValueChange={(v) => analytics.setSource(v as DataSource)}>
          <TabsList>
            <TabsTrigger value="all">All</TabsTrigger>
            <TabsTrigger value="manual">Manual</TabsTrigger>
            <TabsTrigger value="paper">Paper</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {analytics.isLoading && (
        <div className="space-y-6">
          <AnalyticsStatCardsSkeleton />
          <ChartSkeleton />
          <ChartSkeleton />
          <div className="grid gap-4 lg:grid-cols-2">
            <ChartSkeleton />
            <ChartSkeleton />
          </div>
        </div>
      )}

      {!analytics.isLoading && analytics.metrics.totalTrades === 0 && <EmptyState />}

      {!analytics.isLoading && analytics.metrics.totalTrades > 0 && (
        <div className="space-y-6">
          <AnalyticsStatCards metrics={analytics.metrics} />
          <EquityCurveCard data={analytics.equityCurve} />
          <DrawdownCard data={analytics.drawdownSeries} />
          <div className="grid gap-4 lg:grid-cols-2">
            <DistributionCard data={analytics.distribution} />
            <MonthlyReturnsCard data={analytics.monthlyReturns} />
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <SymbolPerformanceCard data={analytics.symbolPerformance} />
            <DayOfWeekCard data={analytics.dayOfWeekPerformance} />
          </div>
        </div>
      )}
    </div>
  );
}
