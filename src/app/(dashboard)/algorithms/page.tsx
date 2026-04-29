"use client";

import { useState } from "react";
import Link from "next/link";
import { Bot, Plus, Telescope } from "lucide-react";
import { AlgorithmCard } from "@/components/algorithms/algorithm-card";
import { EmptyState } from "@/components/shared/empty-state";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAlgorithmsList } from "@/hooks/use-algorithms";
import type { Algorithm, AlgorithmStatus } from "@/types/algorithm";

type GroupKey = "live" | "draft" | "archived";

const GROUPS: Record<GroupKey, { label: string; statuses: AlgorithmStatus[] }> = {
  live: { label: "Active", statuses: ["active", "paused"] },
  draft: { label: "Drafts", statuses: ["draft"] },
  archived: { label: "Archived", statuses: ["archived"] },
};

const EMPTY_DEFAULT = (
  <EmptyState
    icon={<Bot className="h-8 w-8 text-muted-foreground mb-3" />}
    title="No algorithms yet"
    description="Let AI design a trading strategy based on your preferences."
    action={{ href: "/algorithms/generate", label: "Generate your first algorithm" }}
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

export default function AlgorithmsPage() {
  const { data: algorithms, isLoading } = useAlgorithmsList();
  const [tab, setTab] = useState<GroupKey>("live");

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
            AI-generated trading strategies and backtesting.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            render={<Link href="/algorithms/generate-from-search" />}
            nativeButton={false}
          >
            <Telescope className="mr-1.5 h-3.5 w-3.5" />
            Search-find
          </Button>
          <Button size="sm" render={<Link href="/algorithms/generate" />} nativeButton={false}>
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            Generate New
          </Button>
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
              {grouped[key].length === 0 ? emptyForGroup(key) : (
                <AlgorithmGrid algorithms={grouped[key]} />
              )}
            </TabsContent>
          ))}
        </Tabs>
      )}
    </div>
  );
}
