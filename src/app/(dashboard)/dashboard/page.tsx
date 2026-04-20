import { AssetAllocationChart } from "@/components/dashboard/asset-allocation-chart";
import { EmotionWidget } from "@/components/dashboard/emotion-widget";
import { PnlChart } from "@/components/dashboard/pnl-chart";
import { RecentTrades } from "@/components/dashboard/recent-trades";
import { StatCards } from "@/components/dashboard/stat-cards";

export default function DashboardPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-sm text-muted-foreground">
          Your trading overview at a glance.
        </p>
      </div>
      <StatCards />
      <div className="grid gap-4 lg:grid-cols-2">
        <PnlChart />
        <RecentTrades />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <AssetAllocationChart />
        <EmotionWidget />
      </div>
    </div>
  );
}
