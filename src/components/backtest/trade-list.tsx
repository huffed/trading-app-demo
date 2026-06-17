"use client";

import type { BacktestTradeRow } from "@/app/(dashboard)/backtest/actions";
import { Skeleton } from "@/components/ui/skeleton";
import { Surface } from "@/components/ui/surface";
import { cn } from "@/lib/utils";
import { formatPnl, formatPriceValue, pnlColorClass } from "@/lib/utils/pnl";

function rowLabel(t: BacktestTradeRow): string {
  return `${t.side === "long" ? "BUY" : "SELL"} ${t.ticker} @ ${formatPriceValue(t.ticker, t.entry_price)}`;
}

function rowDate(t: BacktestTradeRow): string {
  const d = new Date(t.opened_at);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function TradeList({
  trades,
  isLoading,
  selectedId,
  onSelect,
}: {
  trades: BacktestTradeRow[] | undefined;
  isLoading: boolean;
  selectedId: string | null;
  onSelect: (t: BacktestTradeRow) => void;
}) {
  if (isLoading) {
    return (
      <Surface elevation="low" className="p-3 space-y-2">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-9 w-full" />
        ))}
      </Surface>
    );
  }
  if (!trades || trades.length === 0) {
    return (
      <Surface elevation="low" className="p-4">
        <p className="text-xs text-muted-foreground">
          No trades yet. This algorithm hasn&apos;t opened any positions.
        </p>
      </Surface>
    );
  }
  return (
    <Surface elevation="low" className="overflow-hidden">
      <ul className="divide-y max-h-[640px] overflow-y-auto">
        {trades.map((t) => {
          const pnl = t.realized_pnl ?? t.unrealized_pnl;
          const isOpen = t.status === "open";
          return (
            <li key={t.id}>
              <button
                type="button"
                onClick={() => onSelect(t)}
                className={cn(
                  "w-full text-left px-3 py-2 hover:bg-muted/40 transition-colors",
                  selectedId === t.id && "bg-muted/60"
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium tabular-nums">{rowLabel(t)}</span>
                  <span className={cn("text-xs font-medium tabular-nums", pnlColorClass(pnl))}>
                    {formatPnl(pnl)}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2 mt-0.5">
                  <span className="text-[10px] text-muted-foreground">{rowDate(t)}</span>
                  <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                    {isOpen ? "Open" : (t.exit_reason ?? "Closed")}
                  </span>
                </div>
              </button>
            </li>
          );
        })}
      </ul>
    </Surface>
  );
}
