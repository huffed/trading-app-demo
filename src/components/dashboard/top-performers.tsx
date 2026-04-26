"use client";

import { TrendingDown, TrendingUp } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useOpenPositions } from "@/hooks/use-paper-trading";
import { formatCurrency, formatPnl, formatPnlPercent, pnlColorClass } from "@/lib/utils/pnl";
import type { PaperPosition } from "@/types/position";

function PositionRow({ pos }: { pos: PaperPosition }) {
  const pnlPct =
    pos.entry_price > 0 && pos.current_price != null
      ? ((pos.current_price - pos.entry_price) / pos.entry_price) * 100
      : null;

  return (
    <div className="flex items-center justify-between py-2">
      <div className="flex items-center gap-2">
        {pos.unrealized_pnl >= 0 ? (
          <TrendingUp className="h-3.5 w-3.5 text-[var(--profit)]" />
        ) : (
          <TrendingDown className="h-3.5 w-3.5 text-[var(--loss)]" />
        )}
        <div>
          <span className="text-sm font-medium">{pos.ticker}</span>
          <span className="ml-1.5 text-xs text-muted-foreground">
            {pos.current_price != null ? formatCurrency(pos.current_price) : ""}
          </span>
        </div>
      </div>
      <div className="text-right">
        <span className={`text-sm font-medium ${pnlColorClass(pos.unrealized_pnl)}`}>
          {formatPnl(pos.unrealized_pnl)}
        </span>
        {pnlPct != null && (
          <span className={`ml-1.5 text-xs ${pnlColorClass(pnlPct)}`}>
            {formatPnlPercent(pnlPct)}
          </span>
        )}
      </div>
    </div>
  );
}

export function TopPerformers() {
  const { data: positions, isLoading } = useOpenPositions();

  if (isLoading) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">Open Positions</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  if (!positions || positions.length === 0) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">Open Positions</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground py-4 text-center">No open paper positions</p>
        </CardContent>
      </Card>
    );
  }

  const sorted = [...positions].sort((a, b) => b.unrealized_pnl - a.unrealized_pnl);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">Open Positions</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="divide-y divide-border">
          {sorted.map((pos) => (
            <PositionRow key={pos.id} pos={pos} />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
