"use client";

/**
 * Open paper positions, sorted by unrealized P&L. Tabular display via
 * the `DataRow` primitive — ticker + side as the label group, signed
 * P&L as the value with profit/loss tinting.
 */
import { TrendingDown, TrendingUp } from "lucide-react";
import { DataRow } from "@/components/ui/data-row";
import { Skeleton } from "@/components/ui/skeleton";
import { Surface } from "@/components/ui/surface";
import { useAutoRefreshPrices, useOpenPositions } from "@/hooks/use-paper-trading";
import {
  displayedPnl,
  formatPnl,
  formatPnlPercent,
  formatPriceValue,
  pnlColorClass,
} from "@/lib/utils/pnl";
import type { PaperPosition } from "@/types/position";

function PnlValue({ pos }: { pos: PaperPosition }) {
  const pnl = displayedPnl(pos) ?? 0;
  const pct =
    pos.entry_price > 0 && pos.current_price != null
      ? ((pos.current_price - pos.entry_price) / pos.entry_price) * 100 * (pos.side === "long" ? 1 : -1)
      : null;
  return (
    <span className={`flex items-baseline gap-2 ${pnlColorClass(pnl)}`}>
      <span className="font-semibold">{formatPnl(pnl)}</span>
      {pct != null && <span className="text-xs">{formatPnlPercent(pct)}</span>}
    </span>
  );
}

export function OpenPositionsPanel() {
  const { data: positions = [], isLoading } = useOpenPositions();
  // Live unrealized-pnl refresh while positions are open.
  useAutoRefreshPrices(undefined, positions.length > 0);

  // Sort by displayed (broker-truth) P&L, not the raw paper unrealized.
  const sorted = [...positions].sort((a, b) => (displayedPnl(b) ?? 0) - (displayedPnl(a) ?? 0));

  return (
    <Surface elevation="mid" className="p-5 lg:col-span-6">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">Open positions</p>
        {sorted.length > 0 && (
          <span className="font-mono text-xs tabular-nums text-muted-foreground">
            {sorted.length}
          </span>
        )}
      </div>
      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      ) : sorted.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">No open paper positions.</p>
      ) : (
        <div className="flex flex-col">
          {sorted.map((p) => (
            <DataRow
              key={p.id}
              label={p.ticker}
              hint={`${p.side === "long" ? "Long" : "Short"} @ ${formatPriceValue(p.ticker, p.entry_price)} · current ${
                p.current_price != null ? formatPriceValue(p.ticker, p.current_price) : "—"
              }`}
              value={<PnlValue pos={p} />}
            />
          ))}
        </div>
      )}
      {sorted.length === 0 ? null : (
        <div className="mt-3 flex items-center justify-end gap-2 text-xs text-muted-foreground">
          {sorted.some((p) => (displayedPnl(p) ?? 0) > 0) && (
            <span className="flex items-center gap-1">
              <TrendingUp className="h-3 w-3 text-[var(--profit)]" />
              {sorted.filter((p) => (displayedPnl(p) ?? 0) > 0).length} up
            </span>
          )}
          {sorted.some((p) => (displayedPnl(p) ?? 0) < 0) && (
            <span className="flex items-center gap-1">
              <TrendingDown className="h-3 w-3 text-[var(--loss)]" />
              {sorted.filter((p) => (displayedPnl(p) ?? 0) < 0).length} down
            </span>
          )}
        </div>
      )}
    </Surface>
  );
}
