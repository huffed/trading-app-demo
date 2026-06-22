"use client";

import { useState } from "react";
import { Bot, LayoutGrid, Layers } from "lucide-react";
import { AlgorithmCard } from "@/components/algorithms/algorithm-card";
import { StrategyCard } from "@/components/algorithms/strategy-card";
import { EmptyState } from "@/components/shared/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAlgorithmsList } from "@/hooks/use-algorithms";
import { useStrategiesList } from "@/hooks/use-strategies";
import type { Algorithm, AlgorithmStatus, Strategy } from "@/types/algorithm";

type GroupKey = "live" | "draft" | "archived";
type ViewMode = "strategy" | "flat";

const GROUPS: Record<GroupKey, { label: string; statuses: AlgorithmStatus[] }> = {
  live: { label: "Active", statuses: ["active", "paused"] },
  draft: { label: "Drafts", statuses: ["draft"] },
  archived: { label: "Archived", statuses: ["archived"] },
};

const EMPTY_DEFAULT = (
  <EmptyState
    icon={<Bot className="h-8 w-8 text-muted-foreground mb-3" />}
    title="No algorithms yet"
    description="Algorithms are deployed via scripts in scripts/deploy-*.ts"
  />
);

function emptyForGroup(group: GroupKey) {
  if (group === "live") return EMPTY_DEFAULT;
  return (
    <EmptyState
      icon={<Bot className="h-8 w-8 text-muted-foreground mb-3" />}
      title={group === "draft" ? "No drafts" : "Nothing archived"}
      description={
        group === "draft"
          ? "Algorithms you've started but haven't activated will appear here."
          : "Algorithms you've archived will appear here. Useful for keeping the active list focused."
      }
    />
  );
}

function AlgorithmGrid({ algorithms }: { algorithms: Algorithm[] }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {algorithms.map((algo) => (
        <AlgorithmCard key={algo.id} algorithm={algo} />
      ))}
    </div>
  );
}

/**
 * Renders algorithms grouped by their strategy umbrella. Each strategy
 * gets a StrategyCard with its instances. Algorithms with null
 * strategy_id (standalone / pre-umbrella) get a residual "Other" bucket
 * at the bottom rendered with the flat grid.
 */
function StrategyGroupedView({
  algorithms,
  strategies,
}: {
  algorithms: Algorithm[];
  strategies: Strategy[];
}) {
  const byStrategy = new Map<string, Algorithm[]>();
  const standalone: Algorithm[] = [];
  for (const a of algorithms) {
    if (a.strategy_id) {
      const instancesForStrategy = byStrategy.get(a.strategy_id) ?? [];
      instancesForStrategy.push(a);
      byStrategy.set(a.strategy_id, instancesForStrategy);
    } else {
      standalone.push(a);
    }
  }
  // Sort strategy cards by instance count (more instances first), then name.
  const orderedStrategies = strategies
    .filter((s) => byStrategy.has(s.id))
    .sort((a, b) => {
      const ai = byStrategy.get(a.id)?.length ?? 0;
      const bi = byStrategy.get(b.id)?.length ?? 0;
      if (ai !== bi) return bi - ai;
      return a.name.localeCompare(b.name);
    });

  return (
    <div className="space-y-4">
      {orderedStrategies.map((s) => (
        <StrategyCard
          key={s.id}
          strategy={s}
          instances={byStrategy.get(s.id) ?? []}
          defaultOpen={false}
        />
      ))}
      {standalone.length > 0 && (
        <div className="space-y-2 pt-2">
          <h2 className="text-sm font-semibold text-muted-foreground">
            Standalone (no strategy)
          </h2>
          <AlgorithmGrid algorithms={standalone} />
        </div>
      )}
    </div>
  );
}

function renderTabBody(
  key: GroupKey,
  algorithms: Algorithm[],
  viewMode: ViewMode,
  strategies: Strategy[]
) {
  if (algorithms.length === 0) return emptyForGroup(key);
  if (viewMode === "strategy" && strategies.length > 0) {
    return <StrategyGroupedView algorithms={algorithms} strategies={strategies} />;
  }
  return <AlgorithmGrid algorithms={algorithms} />;
}

function ViewModeToggle({
  value,
  onChange,
}: {
  value: ViewMode;
  onChange: (v: ViewMode) => void;
}) {
  return (
    <div className="flex items-center rounded-md border bg-background overflow-hidden">
      <button
        type="button"
        onClick={() => onChange("strategy")}
        className={`flex items-center gap-1.5 px-2.5 py-1 text-xs transition-colors ${
          value === "strategy" ? "bg-muted font-medium" : "hover:bg-muted/40"
        }`}
        title="Group by strategy"
      >
        <Layers className="h-3.5 w-3.5" />
        By strategy
      </button>
      <button
        type="button"
        onClick={() => onChange("flat")}
        className={`flex items-center gap-1.5 px-2.5 py-1 text-xs transition-colors ${
          value === "flat" ? "bg-muted font-medium" : "hover:bg-muted/40"
        }`}
        title="Flat list of all algorithms"
      >
        <LayoutGrid className="h-3.5 w-3.5" />
        All algos
      </button>
    </div>
  );
}

export default function AlgorithmsPage() {
  const { data: algorithms, isLoading } = useAlgorithmsList();
  const { data: strategies } = useStrategiesList();
  const [tab, setTab] = useState<GroupKey>("live");
  const [viewMode, setViewMode] = useState<ViewMode>("strategy");

  const grouped: Record<GroupKey, Algorithm[]> = {
    live: [],
    draft: [],
    archived: [],
  };
  for (const a of algorithms ?? []) {
    if (GROUPS.live.statuses.includes(a.status)) grouped.live.push(a);
    else if (GROUPS.draft.statuses.includes(a.status)) grouped.draft.push(a);
    else if (GROUPS.archived.statuses.includes(a.status)) grouped.archived.push(a);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Algorithms</h1>
          <p className="text-sm text-muted-foreground">
            Deployed trading strategies grouped by family.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <ViewModeToggle value={viewMode} onChange={setViewMode} />
        </div>
      </div>

      {isLoading && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-40 w-full rounded-lg" />
          ))}
        </div>
      )}

      {!isLoading && (
        <Tabs value={tab} onValueChange={(v) => setTab(v as GroupKey)}>
          <TabsList>
            {(Object.keys(GROUPS) as GroupKey[]).map((key) => (
              <TabsTrigger key={key} value={key}>
                {GROUPS[key].label}
                <span className="ml-1.5 text-xs text-muted-foreground">
                  ({grouped[key].length})
                </span>
              </TabsTrigger>
            ))}
          </TabsList>
          {(Object.keys(GROUPS) as GroupKey[]).map((key) => (
            <TabsContent key={key} value={key} className="pt-2">
              {renderTabBody(key, grouped[key], viewMode, strategies ?? [])}
            </TabsContent>
          ))}
        </Tabs>
      )}
    </div>
  );
}
