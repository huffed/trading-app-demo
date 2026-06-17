"use client";

import { Star } from "lucide-react";
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

/** Best cell = highest Calmar among cells that:
 *   (a) didn't breach the DD threshold,
 *   (b) traded at least once,
 *   (c) have a positive return.
 *  Returns null when no cell qualifies (every cell breached DD or lost). */
function pickWinner(
  cells: GeometryCell[],
  ddBreachThreshold: number | null
): GeometryCell | null {
  const eligible = cells.filter((c) => {
    if (c.total_trades === 0) return false;
    if (c.total_return <= 0) return false;
    if (ddBreachThreshold != null && c.max_drawdown >= ddBreachThreshold) return false;
    return true;
  });
  if (eligible.length === 0) return null;
  return eligible.reduce((best, c) => {
    const bestCalmar = best.calmar ?? -Infinity;
    const cellCalmar = c.calmar ?? -Infinity;
    return cellCalmar > bestCalmar ? c : best;
  });
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
  const winner = pickWinner(sweep.cells, ddBreachThreshold);
  const winnerKey = winner ? `${winner.rr}-${winner.lookback}` : null;

  return (
    <Surface elevation="low" className="p-4">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">
          RR × lookback geometry sweep
        </p>
        <WinnerSummary winner={winner} />
      </div>
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
            winnerKey={winnerKey}
          />
        ))}
      </div>
      <Legend ddBreachThreshold={ddBreachThreshold} />
    </Surface>
  );
}

function WinnerSummary({ winner }: { winner: GeometryCell | null }) {
  if (!winner) {
    return (
      <span className="text-[10px] text-muted-foreground">
        no surviving cell (every cell breached DD or lost)
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1 text-[11px] text-amber-500 font-medium">
      <Star className="h-3 w-3 fill-current" />
      best: RR={winner.rr} · lb={winner.lookback} · {formatPnl(winner.total_return)} ·{" "}
      DD {winner.max_drawdown.toFixed(1)}% · Calmar {winner.calmar?.toFixed(1) ?? "—"}
    </span>
  );
}

function Legend({ ddBreachThreshold }: { ddBreachThreshold: number | null }) {
  return (
    <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
      <span className="flex items-center gap-1">
        <Star className="h-3 w-3 text-amber-500 fill-amber-500" />
        winner (highest Calmar, no DD breach, positive return)
      </span>
      {ddBreachThreshold != null && (
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-sm ring-1 ring-[var(--loss)]/60" />
          DD ≥ {ddBreachThreshold}% (would breach prop_firm halt)
        </span>
      )}
    </div>
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
  winnerKey,
}: {
  rr: number;
  cells: GeometryCell[];
  grid: GeometrySweep["grid"];
  maxAbs: number;
  selectedKey: string | null;
  onSelect: (cell: GeometryCell) => void;
  ddBreachThreshold: number | null;
  winnerKey: string | null;
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
        const isWinner = key === winnerKey;
        return (
          <button
            key={lb}
            type="button"
            onClick={() => onSelect(cell)}
            className={cn(
              "rounded-md border p-2 text-left hover:border-primary/60 transition-colors relative",
              cellBgClass(cell, maxAbs),
              selectedKey === key && "border-primary ring-1 ring-primary/40",
              ddBreached && "ring-1 ring-[var(--loss)]/60",
              isWinner && "ring-2 ring-amber-500/70 border-amber-500/60"
            )}
          >
            {isWinner && (
              <Star className="absolute top-1 right-1 h-3 w-3 text-amber-500 fill-amber-500" />
            )}
            <div className={cn("font-semibold tabular-nums text-sm", pnlColorClass(cell.total_return))}>
              {cell.total_trades === 0 ? "—" : formatPnl(cell.total_return)}
            </div>
            <div className="text-[10px] text-muted-foreground tabular-nums mt-0.5">
              {cell.total_trades} trades · {cell.win_rate.toFixed(0)}% WR
            </div>
            <div className={cn("text-[10px] tabular-nums", ddBreached ? "text-[var(--loss)] font-medium" : "text-muted-foreground")}>
              DD {cell.max_drawdown.toFixed(1)}%{ddBreached && " ⚠"}
            </div>
            <div className="text-[10px] text-muted-foreground tabular-nums">
              Calmar {cell.calmar?.toFixed(1) ?? "—"}
            </div>
          </button>
        );
      })}
    </>
  );
}
