"use client";

import { ChevronDown, ChevronUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useSectionState } from "@/hooks/use-section-state";

/**
 * Collapsible section wrapper for the algorithm detail page. Each
 * section has a header with title + optional summary slot + collapse
 * chevron, and persists expanded state to localStorage per algorithm.
 *
 * For sections that should always render (e.g. Status), pass
 * `alwaysExpanded`. The chevron + persistence is then suppressed.
 */
export function AlgoSection({
  storageKey,
  defaultExpanded = false,
  alwaysExpanded = false,
  title,
  summary,
  action,
  children,
}: {
  /** localStorage key (without prefix); use `algo:{id}:section:name`. */
  storageKey: string;
  defaultExpanded?: boolean;
  alwaysExpanded?: boolean;
  title: string;
  /** Optional inline summary, e.g. "6 open · +$NN P&L". */
  summary?: React.ReactNode;
  /** Optional action button to render in the header (right-aligned
   *  before the chevron). */
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  const [expanded, toggle] = useSectionState(storageKey, defaultExpanded);
  const showOpen = alwaysExpanded || expanded;

  return (
    <Card>
      <CardHeader
        className={`flex flex-row items-center justify-between gap-3 space-y-0 ${
          alwaysExpanded ? "" : "cursor-pointer hover:bg-muted/40"
        }`}
        onClick={alwaysExpanded ? undefined : toggle}
      >
        <div className="flex items-baseline gap-3 flex-1 min-w-0">
          <CardTitle className="text-base">{title}</CardTitle>
          {summary && (
            <span className="text-xs text-muted-foreground truncate">{summary}</span>
          )}
        </div>
        {action && <div onClick={(e) => e.stopPropagation()}>{action}</div>}
        {!alwaysExpanded && (
          <Button
            size="icon-sm"
            variant="ghost"
            onClick={(e) => {
              e.stopPropagation();
              toggle();
            }}
          >
            {showOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </Button>
        )}
      </CardHeader>
      {showOpen && <CardContent className="space-y-4">{children}</CardContent>}
    </Card>
  );
}
