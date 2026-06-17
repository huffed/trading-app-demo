"use client";

import { Star } from "lucide-react";
import {
  AXES,
  WINNER_MIN_WR,
  type AxisKey,
  type GeometryCell,
  type GeometrySweep,
} from "@/app/(dashboard)/algorithms/[algoId]/validate/types";
import { Surface } from "@/components/ui/surface";
import { cn } from "@/lib/utils";
import { formatPnl, pnlColorClass } from "@/lib/utils/pnl";

function fmtAxisValue(v: number | boolean, key: AxisKey): string {
  const def = AXES[key];
  if (def.kind === "boolean") return v ? "on" : "off";
  const n = v as number;
  const unit = def.unit ?? "";
  return Number.isInteger(n) ? `${n}${unit}` : `${n}${unit}`;
}

function cellKey(cell: GeometryCell): string {
  return `${String(cell.x)}-${String(cell.y)}`;
}

function cellBgClass(cell: GeometryCell, maxAbs: number): string {
  if (cell.total_trades === 0) return "bg-muted/30";
  const ratio = maxAbs === 0 ? 0 : Math.min(Math.abs(cell.total_return) / maxAbs, 1);
  const bucket = Math.round(ratio * 3);
  if (cell.total_return >= 0) {
    return ["bg-[var(--profit)]/5", "bg-[var(--profit)]/15", "bg-[var(--profit)]/25", "bg-[var(--profit)]/35"][bucket];
  }
  return ["bg-[var(--loss)]/5", "bg-[var(--loss)]/15", "bg-[var(--loss)]/25", "bg-[var(--loss)]/35"][bucket];
}

function pickWinner(
  cells: GeometryCell[],
  ddBreachThreshold: number | null
): GeometryCell | null {
  const eligible = cells.filter((c) => {
    if (c.total_trades === 0) return false;
    if (c.total_return <= 0) return false;
    if (c.win_rate < WINNER_MIN_WR) return false;
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
  ddBreachThreshold: number | null;
}) {
  const maxAbs = Math.max(...sweep.cells.map((c) => Math.abs(c.total_return)));
  const winner = pickWinner(sweep.cells, ddBreachThreshold);
  const winnerKey = winner ? cellKey(winner) : null;

  return (
    <Surface elevation="low" className="p-4">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">
          {AXES[sweep.y_axis].label} × {AXES[sweep.x_axis].label}
        </p>
        <WinnerSummary winner={winner} sweep={sweep} />
      </div>
      <div
        className="grid gap-1 text-xs"
        style={{
          gridTemplateColumns: `auto repeat(${sweep.x_values.length}, 1fr)`,
        }}
      >
        <div />
        {sweep.x_values.map((xv) => (
          <div
            key={String(xv)}
            className="text-center text-[10px] uppercase tracking-wide text-muted-foreground py-1"
          >
            {fmtAxisValue(xv, sweep.x_axis)}
          </div>
        ))}
        {sweep.y_values.map((yv) => (
          <CellRow
            key={String(yv)}
            yv={yv}
            sweep={sweep}
            maxAbs={maxAbs}
            selectedKey={selectedKey}
            onSelect={onSelect}
            ddBreachThreshold={ddBreachThreshold}
            winnerKey={winnerKey}
          />
        ))}
      </div>
      <Legend ddBreachThreshold={ddBreachThreshold} />
      <FixedAxesSummary sweep={sweep} />
    </Surface>
  );
}

function WinnerSummary({
  winner,
  sweep,
}: {
  winner: GeometryCell | null;
  sweep: GeometrySweep;
}) {
  if (!winner) {
    return (
      <span className="text-[10px] text-muted-foreground">
        no surviving cell (every cell breached DD, lost, or WR &lt; {WINNER_MIN_WR}%)
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1 text-[11px] text-amber-500 font-medium">
      <Star className="h-3 w-3 fill-current" />
      best: {AXES[sweep.y_axis].label}={fmtAxisValue(winner.y, sweep.y_axis)} ·{" "}
      {AXES[sweep.x_axis].label}={fmtAxisValue(winner.x, sweep.x_axis)} ·{" "}
      {formatPnl(winner.total_return)} · DD {winner.max_drawdown.toFixed(1)}% · WR{" "}
      {winner.win_rate.toFixed(0)}% · Calmar {winner.calmar?.toFixed(1) ?? "—"}
    </span>
  );
}

function Legend({ ddBreachThreshold }: { ddBreachThreshold: number | null }) {
  return (
    <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
      <span className="flex items-center gap-1">
        <Star className="h-3 w-3 text-amber-500 fill-amber-500" />
        winner (highest Calmar · positive return · DD passes · WR &ge; {WINNER_MIN_WR}%)
      </span>
      {ddBreachThreshold != null && (
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-sm ring-1 ring-[var(--loss)]/60" />
          DD &ge; {ddBreachThreshold}% (would breach prop_firm halt)
        </span>
      )}
      <span className="flex items-center gap-1">
        <span className="inline-block h-2 w-2 rounded-sm bg-muted/60" />
        dimmed = WR &lt; {WINNER_MIN_WR}% (too noisy to trust as winner)
      </span>
    </div>
  );
}

function FixedAxesSummary({ sweep }: { sweep: GeometrySweep }) {
  const entries = Object.entries(sweep.fixed) as [AxisKey, number | boolean][];
  if (entries.length === 0) return null;
  return (
    <p className="mt-3 text-[10px] text-muted-foreground border-t pt-2">
      <span className="font-medium">Fixed at:</span>{" "}
      {entries.map(([k, v], i) => (
        <span key={k}>
          {i > 0 && " · "}
          {AXES[k].label}={fmtAxisValue(v, k)}
        </span>
      ))}
    </p>
  );
}

function CellRow({
  yv,
  sweep,
  maxAbs,
  selectedKey,
  onSelect,
  ddBreachThreshold,
  winnerKey,
}: {
  yv: number | boolean;
  sweep: GeometrySweep;
  maxAbs: number;
  selectedKey: string | null;
  onSelect: (cell: GeometryCell) => void;
  ddBreachThreshold: number | null;
  winnerKey: string | null;
}) {
  return (
    <>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground self-center pr-1 text-right">
        {fmtAxisValue(yv, sweep.y_axis)}
      </div>
      {sweep.x_values.map((xv) => {
        const cell = sweep.cells.find((c) => c.x === xv && c.y === yv);
        if (!cell) return <div key={String(xv)} className="rounded-md border bg-muted/30 p-2" />;
        return (
          <CellButton
            key={String(xv)}
            cell={cell}
            maxAbs={maxAbs}
            selectedKey={selectedKey}
            onSelect={onSelect}
            ddBreachThreshold={ddBreachThreshold}
            winnerKey={winnerKey}
          />
        );
      })}
    </>
  );
}

function CellButton({
  cell,
  maxAbs,
  selectedKey,
  onSelect,
  ddBreachThreshold,
  winnerKey,
}: {
  cell: GeometryCell;
  maxAbs: number;
  selectedKey: string | null;
  onSelect: (cell: GeometryCell) => void;
  ddBreachThreshold: number | null;
  winnerKey: string | null;
}) {
  const key = cellKey(cell);
  const ddBreached = ddBreachThreshold != null && cell.max_drawdown >= ddBreachThreshold;
  const lowWr = cell.total_trades > 0 && cell.win_rate < WINNER_MIN_WR;
  const isWinner = key === winnerKey;
  return (
    <button
      type="button"
      onClick={() => onSelect(cell)}
      className={cn(
        "rounded-md border p-2 text-left hover:border-primary/60 transition-colors relative",
        cellBgClass(cell, maxAbs),
        lowWr && "opacity-60",
        selectedKey === key && "border-primary ring-1 ring-primary/40 opacity-100",
        ddBreached && "ring-1 ring-[var(--loss)]/60",
        isWinner && "ring-2 ring-amber-500/70 border-amber-500/60 opacity-100"
      )}
    >
      {isWinner && (
        <Star className="absolute top-1 right-1 h-3 w-3 text-amber-500 fill-amber-500" />
      )}
      <div className={cn("font-semibold tabular-nums text-sm", pnlColorClass(cell.total_return))}>
        {cell.total_trades === 0 ? "—" : formatPnl(cell.total_return)}
      </div>
      <div className={cn("text-[10px] tabular-nums mt-0.5", lowWr ? "text-amber-600/80" : "text-muted-foreground")}>
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
}
