import { ActivityFeed } from "@/components/dashboard/activity-feed";
import { AssetAllocationChart } from "@/components/dashboard/asset-allocation-chart";
import { EmotionWidget } from "@/components/dashboard/emotion-widget";
import { PaperTradingCard } from "@/components/dashboard/paper-trading-card";
import { PnlChart } from "@/components/dashboard/pnl-chart";
import { RecentTrades } from "@/components/dashboard/recent-trades";
import { StatCards } from "@/components/dashboard/stat-cards";
import { TopPerformers } from "@/components/dashboard/top-performers";

export default function DashboardPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-sm text-muted-foreground">Your trading overview at a glance.</p>
      </div>
      <StatCards />
      <PaperTradingCard />
      <div className="grid gap-4 lg:grid-cols-2">
        <PnlChart />
        <TopPerformers />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <RecentTrades />
        <ActivityFeed />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <AssetAllocationChart />
        <EmotionWidget />
      </div>
    </div>
  );
}
