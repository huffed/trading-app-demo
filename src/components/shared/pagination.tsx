import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";

interface PaginationProps {
  page: number;
  totalPages: number;
  total: number;
  setPage: (page: number) => void;
  /** Singular label of the row noun (e.g. "trade", "entry"). */
  noun: string;
  /** Plural form when count !== 1. Defaults to `${noun}s`. */
  pluralNoun?: string;
}

/** Compact prev/next pagination with a "{count} {noun}" tally. Renders
 *  nothing when totalPages <= 1, so it's safe to drop into any list view. */
export function Pagination({
  page,
  totalPages,
  total,
  setPage,
  noun,
  pluralNoun,
}: PaginationProps) {
  if (totalPages <= 1) return null;
  const label = total === 1 ? noun : (pluralNoun ?? `${noun}s`);
  return (
    <div className="flex items-center justify-between px-2 py-3">
      <p className="text-xs text-muted-foreground">
        {total} {label}
      </p>
      <div className="flex items-center gap-1">
        <Button
          variant="outline"
          size="icon-xs"
          disabled={page <= 1}
          onClick={() => setPage(page - 1)}
        >
          <ChevronLeft className="h-3 w-3" />
        </Button>
        <span className="px-2 text-xs text-muted-foreground">
          {page} / {totalPages}
        </span>
        <Button
          variant="outline"
          size="icon-xs"
          disabled={page >= totalPages}
          onClick={() => setPage(page + 1)}
        >
          <ChevronRight className="h-3 w-3" />
        </Button>
      </div>
    </div>
  );
}
