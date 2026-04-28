"use client";

import Link from "next/link";
import { Plus } from "lucide-react";
import { JournalCard } from "@/components/journal/journal-card";
import { JournalFilters } from "@/components/journal/journal-filters";
import { EmptyState } from "@/components/shared/empty-state";
import { Pagination } from "@/components/shared/pagination";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useJournalEntries } from "@/hooks/use-journal";
import { useJournalFilterStore } from "@/stores/journal-filter-store";
import type { JournalEntry } from "@/types/journal";

const PER_PAGE = 12;

interface CardGridProps {
  entries: JournalEntry[];
  total: number;
  page: number;
  totalPages: number;
  setPage: (page: number) => void;
}

function CardGrid({ entries, total, page, totalPages, setPage }: CardGridProps) {
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {entries.map((entry) => (
          <JournalCard key={entry.id} entry={entry} />
        ))}
      </div>
      <Pagination
        page={page}
        totalPages={totalPages}
        total={total}
        setPage={setPage}
        noun="entry"
        pluralNoun="entries"
      />
    </>
  );
}

const EMPTY = (
  <EmptyState
    title="No journal entries yet"
    description="Start your first entry to begin tracking your trading mindset."
    action={{ href: "/journal/new", label: "Write your first entry" }}
  />
);

export default function JournalPage() {
  const { filters, page, setPage } = useJournalFilterStore();
  const { data, isLoading } = useJournalEntries(filters, page, PER_PAGE);

  const entries = data?.entries ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Journal</h1>
          <p className="text-sm text-muted-foreground">
            Reflect on your trades and track your mindset.
          </p>
        </div>
        <Button size="sm" render={<Link href="/journal/new" />} nativeButton={false}>
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          New Entry
        </Button>
      </div>

      <JournalFilters />

      {isLoading && (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-40 w-full rounded-lg" />
          ))}
        </div>
      )}
      {!isLoading && entries.length === 0 && EMPTY}
      {!isLoading && entries.length > 0 && (
        <CardGrid
          entries={entries}
          total={total}
          page={page}
          totalPages={totalPages}
          setPage={setPage}
        />
      )}
    </div>
  );
}
