"use client";

import Link from "next/link";
import { ArrowRight, NotebookText } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useJournalEntries } from "@/hooks/use-journal";
import { formatRelativeTime } from "@/lib/utils/pnl";
import type { JournalEntry } from "@/types/journal";

const PREVIEW_CHARS = 180;

function FlagsContent({ entries }: { entries: JournalEntry[] }) {
  const analyzed = entries.filter((e) => e.ai_analysis && e.ai_analysis.trim().length > 0);
  if (analyzed.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No AI analysis yet. Run analysis on a journal entry and the flags surface here.
      </p>
    );
  }
  return (
    <div className="space-y-3">
      {analyzed.slice(0, 5).map((entry) => {
        const summary = (entry.ai_analysis ?? "").trim();
        const truncated =
          summary.length > PREVIEW_CHARS ? summary.slice(0, PREVIEW_CHARS) + "…" : summary;
        return (
          <Link
            key={entry.id}
            href={`/journal/${entry.id}`}
            className="block space-y-1 rounded-md border p-2.5 hover:border-foreground/20 transition-colors"
          >
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="font-medium truncate">{entry.title || "Untitled entry"}</span>
              <span className="text-muted-foreground tabular-nums shrink-0">
                {formatRelativeTime(entry.ai_analyzed_at ?? entry.created_at)}
              </span>
            </div>
            <p className="text-xs text-muted-foreground line-clamp-3">{truncated}</p>
          </Link>
        );
      })}
    </div>
  );
}

export function JournalFlagsCard() {
  const { data, isLoading } = useJournalEntries({}, 1, 20);
  const entries = data?.entries ?? [];

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-base flex items-center gap-1.5">
          <NotebookText className="h-4 w-4" />
          Journal flags
        </CardTitle>
        <Link
          href="/journal"
          className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center"
        >
          All entries <ArrowRight className="ml-0.5 h-3 w-3" />
        </Link>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-32 w-full" />
        ) : (
          <FlagsContent entries={entries} />
        )}
      </CardContent>
    </Card>
  );
}
