import { ActivityPanel } from "@/components/dashboard/activity-panel";
import { EquityHero } from "@/components/dashboard/equity-hero";
import { KpiSummary } from "@/components/dashboard/kpi-summary";
import { LiveStatusRail } from "@/components/dashboard/live-status-rail";
import { OpenPositionsPanel } from "@/components/dashboard/open-positions-panel";
import { ContentShell } from "@/components/layout/content-shell";
import { DashboardGrid } from "@/components/layout/dashboard-grid";

export default function DashboardPage() {
  return (
    <ContentShell inspector={<LiveStatusRail />}>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Live trading overview — paper-positions data, scan status, and recent activity.
        </p>
      </div>
      <KpiSummary />
      <div className="mt-6">
        <DashboardGrid>
          <EquityHero />
          <OpenPositionsPanel />
          <ActivityPanel />
        </DashboardGrid>
      </div>
    </ContentShell>
  );
}
