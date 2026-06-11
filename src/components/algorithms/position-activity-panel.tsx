"use client";

import { type PositionEvent } from "@/app/(dashboard)/algorithms/position-events-actions";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { usePositionEvents } from "@/hooks/use-position-stats";
import { ACTIVITY_TYPE_LABELS } from "@/lib/constants/algorithm";
import type { PaperPosition } from "@/types/position";

function formatStamp(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function eventVariant(eventType: string): "default" | "secondary" | "destructive" | "outline" {
  if (eventType === "position_opened" || eventType === "live_order_placed") return "default";
  if (eventType === "position_closed" || eventType === "live_order_closed") return "secondary";
  if (eventType.includes("error") || eventType.includes("halt") || eventType.includes("kill"))
    {return "destructive";}
  return "outline";
}

function summarize(event: PositionEvent): string | null {
  const d = event.details;
  if (!d) return null;
  if (event.event_type === "position_opened") {
    const parts: string[] = [];
    if (typeof d.entry_price === "number") parts.push(`@ ${d.entry_price.toFixed(5)}`);
    if (typeof d.stop_loss_price === "number") parts.push(`SL ${d.stop_loss_price.toFixed(5)}`);
    if (typeof d.take_profit_price === "number") parts.push(`TP ${d.take_profit_price.toFixed(5)}`);
    return parts.join(" · ");
  }
  if (event.event_type === "live_order_placed") {
    const side = typeof d.side === "string" ? d.side : "";
    const vol = typeof d.volume === "number" ? d.volume : null;
    if (vol != null) return `${side} ${vol} lots`;
    return side;
  }
  if (event.event_type === "position_closed" || event.event_type === "live_order_closed") {
    const reason = typeof d.exit_reason === "string" ? d.exit_reason : null;
    const pnl = typeof d.realized_pnl === "number" ? d.realized_pnl : null;
    const parts: string[] = [];
    if (reason) parts.push(reason);
    if (pnl != null) parts.push(`P&L ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}`);
    return parts.join(" · ");
  }
  // Fallback: pull a couple of telemetry fields if present.
  const interestingKeys = ["reason", "side", "volume", "broker_position_id"];
  const bits: string[] = [];
  for (const k of interestingKeys) {
    const v = d[k];
    if (typeof v === "string" || typeof v === "number") bits.push(`${k}=${v}`);
  }
  return bits.length > 0 ? bits.join(" · ") : null;
}

export function PositionActivityPanel({ pos }: { pos: PaperPosition }) {
  const { data: events, isLoading } = usePositionEvents(pos.id, true);

  if (isLoading && !events) {
    return (
      <div className="px-4 py-3 space-y-2">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    );
  }
  if (!events || events.length === 0) {
    return (
      <p className="px-4 py-3 text-sm text-muted-foreground">
        No position-specific events yet. Algorithm-level scan / manage events live in the
        Recent Activity card below.
      </p>
    );
  }
  return (
    <ul className="divide-y">
      {events.map((event) => {
        const summary = summarize(event);
        return (
          <li key={event.id} className="px-4 py-2 text-sm">
            <div className="flex items-baseline gap-2">
              <Badge variant={eventVariant(event.event_type)} className="text-[10px]">
                {ACTIVITY_TYPE_LABELS[event.event_type] ?? event.event_type}
              </Badge>
              <span className="text-xs text-muted-foreground tabular-nums">
                {formatStamp(event.created_at)}
              </span>
            </div>
            {summary && (
              <p className="mt-0.5 text-xs text-muted-foreground tabular-nums">{summary}</p>
            )}
          </li>
        );
      })}
    </ul>
  );
}
