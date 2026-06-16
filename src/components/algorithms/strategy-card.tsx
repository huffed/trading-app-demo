"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight, Bot } from "lucide-react";
import { AlgorithmCard } from "@/components/algorithms/algorithm-card";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { STATUS_COLORS, STATUS_LABELS } from "@/lib/constants/algorithm";
import type { Algorithm, Strategy } from "@/types/algorithm";

interface StrategyCardProps {
  strategy: Strategy;
  instances: Algorithm[];
  /** Default open state. Active strategies expand by default; archived collapse. */
  defaultOpen?: boolean;
}

export function StrategyCard({ strategy, instances, defaultOpen = true }: StrategyCardProps) {
  const [open, setOpen] = useState(defaultOpen);
  const liveCount = instances.filter((a) => a.live_trading_enabled).length;
  const pausedCount = instances.filter((a) => a.status === "paused").length;
  const activeCount = instances.filter((a) => a.status === "active").length;

  return (
    <div className="space-y-3">
      <Card className="overflow-hidden">
        <CardContent className="p-0">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="w-full flex items-start gap-3 p-4 text-left hover:bg-muted/40 transition-colors"
          >
            <div className="mt-0.5 text-muted-foreground">
              {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            </div>
            <Bot className="mt-0.5 h-4 w-4 text-muted-foreground shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="flex items-start justify-between gap-2">
                <h2 className="font-semibold text-sm leading-tight">{strategy.name}</h2>
                <div className="flex items-center gap-1.5 shrink-0">
                  <Badge variant="outline" className="text-xs">
                    {instances.length} {instances.length === 1 ? "instance" : "instances"}
                  </Badge>
                  {liveCount > 0 && (
                    <Badge variant="default" className="text-xs">
                      {liveCount} live
                    </Badge>
                  )}
                  {pausedCount > 0 && (
                    <Badge variant="secondary" className="text-xs">
                      {pausedCount} paused
                    </Badge>
                  )}
                  <Badge variant={STATUS_COLORS[strategy.status] ?? "secondary"} className="text-xs">
                    {STATUS_LABELS[strategy.status] ?? strategy.status}
                  </Badge>
                </div>
              </div>
              {strategy.description && (
                <p className="mt-1 text-xs text-muted-foreground leading-relaxed line-clamp-2">
                  {strategy.description}
                </p>
              )}
              {!open && (
                <p className="mt-1.5 text-xs text-muted-foreground/70">
                  {activeCount} active · {instances.map((a) => extractTicker(a.name)).filter(Boolean).join(", ") || "—"}
                </p>
              )}
            </div>
          </button>
          {open && (
            <div className="border-t bg-muted/20 p-3">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {instances.map((algo) => (
                  <AlgorithmCard key={algo.id} algorithm={algo} />
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/** Pull the ticker out of an algorithm name for the collapsed-state preview.
 *  Names follow patterns like "Library: USD/JPY Coil-Breakout-Long 4h" or
 *  "Library: Gold Coil-Breakout 1h" — extract the second word or pair. */
function extractTicker(name: string): string {
  // Strip "Library: " prefix
  const rest = name.startsWith("Library:") ? name.slice("Library:".length).trim() : name;
  // First token is usually the instrument (Gold, USD/JPY, EUR/USD, etc.)
  const firstToken = rest.split(/\s+/)[0];
  return firstToken || "";
}
