"use client";

import { useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EXIT_REASON_LABELS } from "@/lib/constants/algorithm";
import { displayedPnl, formatPnl, pnlColorClass } from "@/lib/utils/pnl";
import type { PaperPosition } from "@/types/position";
import { PositionActivityPanel } from "./position-activity-panel";
import { PositionChartPanel } from "./position-chart-panel";
import { PositionConditionsPanel } from "./position-conditions-panel";
import { PositionStatsPanel } from "./position-stats-panel";

function formatDuration(openIso: string, closeIso?: string | null): string {
  const start = new Date(openIso).getTime();
  const end = closeIso ? new Date(closeIso).getTime() : Date.now();
  const ms = Math.max(0, end - start);
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMin = minutes % 60;
  if (hours < 24) return `${hours}h ${remMin}m`;
  const days = Math.floor(hours / 24);
  const remHr = hours % 24;
  return `${days}d ${remHr}h`;
}

function CardTrigger({
  pos,
  expanded,
}: {
  pos: PaperPosition;
  expanded: boolean;
}) {
  const isOpen = pos.status === "open";
  const grossPnl = displayedPnl(pos) ?? 0;
  const sideLabel = pos.side === "long" ? "BUY" : "SELL";
  const sideClass =
    pos.side === "long"
      ? "bg-[var(--profit)]/10 text-[var(--profit)]"
      : "bg-[var(--loss)]/10 text-[var(--loss)]";
  const exitReasonLabel = !isOpen
    ? EXIT_REASON_LABELS[pos.exit_reason ?? ""] ?? pos.exit_reason
    : null;

  return (
    <div className="flex w-full items-center gap-3 px-4 py-2.5">
      <span className="font-medium tabular-nums">{pos.ticker}</span>
      <Badge variant="secondary" className={`text-[10px] ${sideClass}`}>
        {sideLabel}
      </Badge>
      <span className={`tabular-nums text-sm ${pnlColorClass(grossPnl)}`}>
        {formatPnl(grossPnl)}
      </span>
      {exitReasonLabel && (
        <Badge variant="outline" className="text-[10px] text-muted-foreground">
          {exitReasonLabel}
        </Badge>
      )}
      <span className="ml-auto text-xs text-muted-foreground tabular-nums">
        {formatDuration(pos.opened_at, pos.closed_at)}
      </span>
      {expanded ? (
        <ChevronUp className="h-4 w-4 text-muted-foreground" />
      ) : (
        <ChevronDown className="h-4 w-4 text-muted-foreground" />
      )}
    </div>
  );
}

type PanelKey = "stats" | "conditions" | "activity" | "chart";

function ExpandedBody({
  pos,
  onClose,
}: {
  pos: PaperPosition;
  onClose?: (pos: PaperPosition) => void;
}) {
  const [tab, setTab] = useState<PanelKey>("stats");
  // Selected condition index drives the chart's pattern overlay. Set
  // by clicking a row in the Conditions panel; null = no overlay.
  const [selectedConditionIndex, setSelectedConditionIndex] = useState<number | null>(null);
  const isOpen = pos.status === "open";

  const onSelectCondition = (idx: number) => {
    setSelectedConditionIndex(idx);
    setTab("chart");
  };

  return (
    <div className="border-t bg-muted/20">
      <Tabs value={tab} onValueChange={(v) => setTab(v as PanelKey)}>
        <div className="px-4 pt-3">
          <TabsList variant="line">
            <TabsTrigger value="stats">Stats</TabsTrigger>
            <TabsTrigger value="conditions">Conditions</TabsTrigger>
            <TabsTrigger value="activity">Activity</TabsTrigger>
            <TabsTrigger value="chart">Chart</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="stats">
          <PositionStatsPanel pos={pos} />
        </TabsContent>
        <TabsContent value="conditions">
          <PositionConditionsPanel
            pos={pos}
            selectedIndex={selectedConditionIndex}
            onSelect={onSelectCondition}
          />
        </TabsContent>
        <TabsContent value="activity">
          <PositionActivityPanel pos={pos} />
        </TabsContent>
        <TabsContent value="chart">
          {tab === "chart" && (
            <PositionChartPanel pos={pos} selectedConditionIndex={selectedConditionIndex} />
          )}
        </TabsContent>
      </Tabs>
      {isOpen && onClose && (
        <div className="flex justify-end px-4 pb-3">
          <Button size="sm" variant="outline" onClick={() => onClose(pos)}>
            Close position
          </Button>
        </div>
      )}
    </div>
  );
}

export function PositionDetailCard({
  pos,
  onClose,
}: {
  pos: PaperPosition;
  /** Manual close handler. Omit / no-op for closed positions. */
  onClose?: (pos: PaperPosition) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="border-b last:border-b-0">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full text-left hover:bg-muted/40"
      >
        <CardTrigger pos={pos} expanded={expanded} />
      </button>
      {expanded && <ExpandedBody pos={pos} onClose={onClose} />}
    </div>
  );
}
