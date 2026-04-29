"use client";

import { useState } from "react";
import { ChevronDown, ChevronUp, Eye } from "lucide-react";
import {
  type NearMiss,
  type NearMissCategory,
} from "@/app/(dashboard)/algorithms/near-miss-actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useNearMissFeed } from "@/hooks/use-near-miss";
import { formatRelativeTime } from "@/lib/utils/pnl";

const CATEGORY_LABEL: Record<NearMissCategory, string> = {
  conditions_close_call: "Conditions",
  conditions_far: "Conditions",
  atr_close_call: "ATR liquidity",
  atr_far: "ATR liquidity",
  news_veto: "News veto",
  halt: "Halted",
  spread: "Spread",
  other: "Other",
};

function categoryVariant(
  category: NearMissCategory
): "default" | "secondary" | "destructive" | "outline" {
  if (category === "conditions_close_call" || category === "atr_close_call") return "default";
  if (category === "halt" || category === "news_veto") return "destructive";
  return "secondary";
}

function closenessColor(value: number): string {
  if (value >= 0.8) return "var(--profit)";
  if (value >= 0.5) return "var(--color-warning, #d97706)";
  return "var(--color-muted-foreground)";
}

function ClosenessBar({ value }: { value: number }) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return (
    <div className="h-1 w-12 overflow-hidden rounded-full bg-muted">
      <div
        className="h-full"
        style={{ width: `${pct}%`, backgroundColor: closenessColor(value) }}
      />
    </div>
  );
}

function NearMissRow({ miss }: { miss: NearMiss }) {
  return (
    <li className="flex items-center gap-3 px-4 py-2 text-sm">
      <span className="font-medium tabular-nums w-16 text-xs">{miss.ticker ?? "—"}</span>
      <Badge variant={categoryVariant(miss.category)} className="text-[10px]">
        {CATEGORY_LABEL[miss.category]}
      </Badge>
      <div className="flex-1 min-w-0 truncate">
        <div className="text-xs">{miss.headline}</div>
        {miss.detail && (
          <div className="text-[10px] text-muted-foreground truncate">{miss.detail}</div>
        )}
      </div>
      <ClosenessBar value={miss.closeness} />
      <span className="text-[10px] text-muted-foreground tabular-nums w-16 text-right">
        {formatRelativeTime(miss.created_at)}
      </span>
    </li>
  );
}

const VISIBLE_LIMIT = 15;

function CollapsedTrigger({
  data,
  onClick,
}: {
  data: { total: number; near_misses: NearMiss[] } | undefined;
  onClick: () => void;
}) {
  const summary = data
    ? `${data.total} considered (${data.near_misses.filter((m) => m.closeness >= 0.6).length} close calls)`
    : "Loading…";
  return (
    <Button
      variant="ghost"
      className="w-full justify-between text-muted-foreground"
      onClick={onClick}
    >
      <span className="flex items-center gap-2">
        <Eye className="h-3.5 w-3.5" />
        Considered (last 48h) — {summary}
      </span>
      <ChevronDown className="h-4 w-4" />
    </Button>
  );
}

function FeedHeader({
  byTicker,
  total,
  closeCalls,
}: {
  byTicker: { ticker: string; count: number; close_calls: number }[];
  total: number;
  closeCalls: number;
}) {
  return (
    <div className="px-4 py-2 flex flex-wrap items-center gap-2 text-xs border-b">
      <span className="text-muted-foreground">By ticker:</span>
      {byTicker.map((t) => (
        <Badge key={t.ticker} variant="outline" className="text-[10px] gap-1">
          <span className="font-medium">{t.ticker}</span>
          <span className="text-muted-foreground">
            {t.count}× {t.close_calls > 0 ? `(${t.close_calls} close)` : ""}
          </span>
        </Badge>
      ))}
      <span className="ml-auto text-muted-foreground">
        {total} total · {closeCalls} close calls
      </span>
    </div>
  );
}

export function NearMissFeed({ algorithmId }: { algorithmId: string }) {
  const [expanded, setExpanded] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const { data, isLoading } = useNearMissFeed(algorithmId, 48);

  if (!expanded) {
    return <CollapsedTrigger data={data ?? undefined} onClick={() => setExpanded(true)} />;
  }

  const total = data?.total ?? 0;
  const closeCalls = data?.near_misses.filter((m) => m.closeness >= 0.6).length ?? 0;
  const allMisses = data?.near_misses ?? [];
  const visibleMisses = showAll ? allMisses : allMisses.slice(0, VISIBLE_LIMIT);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <div>
          <CardTitle className="text-base">Considered (last 48h)</CardTitle>
          <p className="text-xs text-muted-foreground mt-0.5">
            What the algorithm thought about but didn&apos;t enter on. Close calls (≥60% to firing)
            are highlighted.
          </p>
        </div>
        <Button size="icon-sm" variant="ghost" onClick={() => setExpanded(false)}>
          <ChevronUp className="h-4 w-4" />
        </Button>
      </CardHeader>
      <CardContent className="p-0">
        {isLoading && (
          <div className="p-4">
            <Skeleton className="h-24 w-full" />
          </div>
        )}
        {!isLoading && total === 0 && (
          <p className="px-4 py-3 text-sm text-muted-foreground">
            No rejected entries in the last 48h. Either the algo fired on every scan or its
            watchlist isn&apos;t being scanned.
          </p>
        )}
        {!isLoading && total > 0 && (
          <>
            <FeedHeader
              byTicker={data?.by_ticker ?? []}
              total={total}
              closeCalls={closeCalls}
            />
            <ul className="divide-y">
              {visibleMisses.map((miss) => (
                <NearMissRow key={miss.id} miss={miss} />
              ))}
            </ul>
            {total > VISIBLE_LIMIT && (
              <div className="px-4 py-2 border-t">
                <Button
                  size="sm"
                  variant="ghost"
                  className="w-full text-xs"
                  onClick={() => setShowAll((v) => !v)}
                >
                  {showAll ? "Show top 15" : `Show all ${total}`}
                </Button>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
