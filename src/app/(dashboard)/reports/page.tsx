"use client";

import { useState } from "react";
import { EligibilityTab } from "@/components/reports/eligibility-tab";
import { EngineActivityTab } from "@/components/reports/engine-activity-tab";

type Tab = "activity" | "eligibility";

export default function ReportsPage() {
  const [tab, setTab] = useState<Tab>("activity");

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Reports</h1>
        <p className="text-sm text-muted-foreground">
          Operator review surfaces. Engine activity covers cron-tick decisions and gate refusals.
          Promotion eligibility surfaces paper algos against the live-mirror milestone.
        </p>
      </div>

      <div className="flex items-center gap-2 border-b">
        <TabButton active={tab === "activity"} onClick={() => setTab("activity")}>
          Engine activity
        </TabButton>
        <TabButton active={tab === "eligibility"} onClick={() => setTab("eligibility")}>
          Promotion eligibility
        </TabButton>
      </div>

      {tab === "activity" && <EngineActivityTab />}
      {tab === "eligibility" && <EligibilityTab />}
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
