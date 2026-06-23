"use client";

import { useState } from "react";
import { BrokersTab } from "@/components/reports/brokers-tab";
import { CohortTab } from "@/components/reports/cohort-tab";
import { DriftTab } from "@/components/reports/drift-tab";
import { EligibilityTab } from "@/components/reports/eligibility-tab";
import { EngineActivityTab } from "@/components/reports/engine-activity-tab";
import { SearchTab } from "@/components/reports/search-tab";

type Tab = "activity" | "eligibility" | "cohort" | "drift" | "brokers" | "search";

export default function ReportsPage() {
  const [tab, setTab] = useState<Tab>("activity");

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Reports</h1>
        <p className="text-sm text-muted-foreground">
          Operator review surfaces. Engine activity covers cron-tick decisions and gate refusals.
          Promotion eligibility surfaces paper algos against the live-mirror milestone. Cohort
          surfaces per-cohort expectancy + decay flags + shadow-gate candidates (SG.6). Drift
          surfaces per-algo performance decay vs backtest baseline + recent halt/warn events
          (SG.5). Brokers surfaces token expiry / stale sync / sibling risk divergence /
          snapshot drift alerts (SG.9). Search shows the quant-firm-grade systematic search
          state — enumerated universe, per-criterion blockers, survivor list.
        </p>
      </div>

      <div className="flex items-center gap-2 border-b">
        <TabButton active={tab === "activity"} onClick={() => setTab("activity")}>
          Engine activity
        </TabButton>
        <TabButton active={tab === "eligibility"} onClick={() => setTab("eligibility")}>
          Promotion eligibility
        </TabButton>
        <TabButton active={tab === "cohort"} onClick={() => setTab("cohort")}>
          Cohort
        </TabButton>
        <TabButton active={tab === "drift"} onClick={() => setTab("drift")}>
          Drift
        </TabButton>
        <TabButton active={tab === "brokers"} onClick={() => setTab("brokers")}>
          Brokers
        </TabButton>
        <TabButton active={tab === "search"} onClick={() => setTab("search")}>
          Search
        </TabButton>
      </div>

      {tab === "activity" && <EngineActivityTab />}
      {tab === "eligibility" && <EligibilityTab />}
      {tab === "cohort" && <CohortTab />}
      {tab === "drift" && <DriftTab />}
      {tab === "brokers" && <BrokersTab />}
      {tab === "search" && <SearchTab />}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-3 py-1.5 text-sm transition-colors border-b-2 -mb-px ${
        active
          ? "border-primary text-foreground font-medium"
          : "border-transparent text-muted-foreground hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}
