"use client";

import type { GeometryCell, GeometrySweep } from "@/app/(dashboard)/algorithms/[algoId]/validate/types";
import { Surface } from "@/components/ui/surface";
import { cn } from "@/lib/utils";
import { formatPnl, pnlColorClass } from "@/lib/utils/pnl";

/** Background gradient for a cell based on its total_return relative to
 *  the sweep's min/max. Green for positive, red for negative, intensity
 *  scales with magnitude. */
function cellBgClass(cell: GeometryCell, maxAbs: number): string {
  if (cell.total_trades === 0) return "bg-muted/30";
  const ratio = maxAbs === 0 ? 0 : Math.min(Math.abs(cell.total_return) / maxAbs, 1);
  const bucket = Math.round(ratio * 3); // 0-3
  if (cell.total_return >= 0) {
    return ["bg-[var(--profit)]/5", "bg-[var(--profit)]/15", "bg-[var(--profit)]/25", "bg-[var(--profit)]/35"][bucket];
  }
  return ["bg-[var(--loss)]/5", "bg-[var(--loss)]/15", "bg-[var(--loss)]/25", "bg-[var(--loss)]/35"][bucket];
}

export function GridHeatmap({
  sweep,
  selectedKey,
  onSelect,
  ddBreachThreshold,
}: {
  sweep: GeometrySweep;
  selectedKey: string | null;
  onSelect: (cell: GeometryCell) => void;
  /** prop_firm.max_drawdown from the algo; cells exceeding this get a red ring. */
  ddBreachThreshold: number | null;
}) {
  const maxAbs = Math.max(...sweep.cells.map((c) => Math.abs(c.total_return)));

  return (
    <Surface elevation="low" className="p-4">
      <p className="mb-3 text-xs uppercase tracking-wide text-muted-foreground">
        RR × lookback geometry sweep
      </p>
      <div
        className="grid gap-1 text-xs"
        style={{
          gridTemplateColumns: `auto repeat(${sweep.grid.lookback.length}, 1fr)`,
        }}
      >
        <div />
        {sweep.grid.lookback.map((lb) => (
          <div key={lb} className="text-center text-[10px] uppercase tracking-wide text-muted-foreground py-1">
            lb={lb}
          </div>
        ))}
        {sweep.grid.rr.map((rr) => (
          <CellRow
            key={rr}
            rr={rr}
            cells={sweep.cells.filter((c) => c.rr === rr)}
            grid={sweep.grid}
            maxAbs={maxAbs}
            selectedKey={selectedKey}
            onSelect={onSelect}
            ddBreachThreshold={ddBreachThreshold}
          />
        ))}
      </div>
    </Surface>
  );
}

function CellRow({
  rr,
  cells,
  grid,
  maxAbs,
  selectedKey,
  onSelect,
  ddBreachThreshold,
}: {
  rr: number;
  cells: GeometryCell[];
  grid: GeometrySweep["grid"];
  maxAbs: number;
  selectedKey: string | null;
  onSelect: (cell: GeometryCell) => void;
  ddBreachThreshold: number | null;
}) {
  return (
    <>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground self-center pr-1 text-right">
        RR={rr}
      </div>
      {grid.lookback.map((lb) => {
        const cell = cells.find((c) => c.lookback === lb);
        if (!cell) return <div key={lb} className="rounded-md border bg-muted/30 p-2" />;
        const key = `${cell.rr}-${cell.lookback}`;
        const ddBreached = ddBreachThreshold != null && cell.max_drawdown >= ddBreachThreshold;
        return (
          <button
            key={lb}
            type="button"
            onClick={() => onSelect(cell)}
            className={cn(
              "rounded-md border p-2 text-left hover:border-primary/60 transition-colors",
              cellBgClass(cell, maxAbs),
              selectedKey === key && "border-primary ring-1 ring-primary/40",
              ddBreached && "ring-1 ring-[var(--loss)]/60"
            )}
          >
            <div className={cn("font-semibold tabular-nums text-sm", pnlColorClass(cell.total_return))}>
              {cell.total_trades === 0 ? "—" : formatPnl(cell.total_return)}
            </div>
            <div className="text-[10px] text-muted-foreground tabular-nums mt-0.5">
              {cell.total_trades} trades · {cell.win_rate.toFixed(0)}% WR
            </div>
            <div className={cn("text-[10px] tabular-nums", ddBreached ? "text-[var(--loss)] font-medium" : "text-muted-foreground")}>
              DD {cell.max_drawdown.toFixed(1)}%{ddBreached && " ⚠"}
            </div>
          </button>
        );
      })}
    </>
  );
}
