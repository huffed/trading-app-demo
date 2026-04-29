"use client";

import { Clock } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useActivityLog } from "@/hooks/use-paper-trading";
import { ACTIVITY_TYPE_LABELS } from "@/lib/constants/algorithm";
import { formatRelativeTime } from "@/lib/utils/pnl";
import { AlgoSection } from "./algo-section";

interface ActivityEntry {
  id: string;
  event_type: string;
  ticker: string | null;
  created_at: string;
}

function ActivityRow({ entry }: { entry: ActivityEntry }) {
  return (
    <div className="flex items-center gap-3 text-sm">
      <Clock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <div className="flex-1 min-w-0">
        <span className="font-medium">
          {ACTIVITY_TYPE_LABELS[entry.event_type] ?? entry.event_type}
        </span>
        {entry.ticker && (
          <Badge variant="outline" className="ml-1.5 text-xs">
            {entry.ticker}
          </Badge>
        )}
      </div>
      <span className="text-xs text-muted-foreground shrink-0">
        {formatRelativeTime(entry.created_at)}
      </span>
    </div>
  );
}

function ActivityBody({
  entries,
  isLoading,
}: {
  entries: ActivityEntry[];
  isLoading: boolean;
}) {
  if (isLoading) return <Skeleton className="h-24 w-full" />;
  if (entries.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">No activity yet. Run a scan to get started.</p>
    );
  }
  return (
    <div className="space-y-2">
      {entries.map((entry) => (
        <ActivityRow key={entry.id} entry={entry} />
      ))}
    </div>
  );
}

/**
 * Algorithm-level event stream. Per-position events live in the
 * position card's Activity sub-tab; this section shows everything
 * else: scan_started/completed, halts, errors, divergence, etc.
 *
 * Default collapsed — operators check it when investigating, not
 * during routine daily review.
 */
export function AlgoActivitySection({ algorithmId }: { algorithmId: string }) {
  const { data, isLoading } = useActivityLog({ algorithm_id: algorithmId }, 1, 20);
  const entries = data?.entries ?? [];

  return (
    <AlgoSection storageKey={`algo:${algorithmId}:section:activity`} title="Activity log">
      <ActivityBody entries={entries} isLoading={isLoading} />
    </AlgoSection>
  );
}
