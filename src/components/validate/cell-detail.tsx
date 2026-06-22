"use client";

import { useState } from "react";
import { CheckCircle2, Loader2 } from "lucide-react";
import {
  AXES,
  type AxisKey,
  type GeometryCell,
} from "@/app/(dashboard)/algorithms/[algoId]/validate/types";
import { Button } from "@/components/ui/button";
import { DataRow } from "@/components/ui/data-row";
import { Surface } from "@/components/ui/surface";
import { useApplyCellConfig } from "@/hooks/use-geometry-sweep";
import { cn } from "@/lib/utils";
import { formatPnl, pnlColorClass } from "@/lib/utils/pnl";

function fmtAxisValue(v: number | boolean, key: AxisKey): string {
  const def = AXES[key];
  if (def.kind === "boolean") return v ? "on" : "off";
  const n = v as number;
  return `${n}${def.unit ?? ""}`;
}

export function CellDetail({
  algorithmId,
  cell,
  xAxis,
  yAxis,
  liveTradingEnabled,
}: {
  algorithmId: string;
  cell: GeometryCell;
  xAxis: AxisKey;
  yAxis: AxisKey;
  liveTradingEnabled: boolean;
}) {
  const apply = useApplyCellConfig();
  const [isApplied, setIsApplied] = useState(false);
  const years = Object.keys(cell.per_year).sort();

  async function handleApply() {
    await apply.mutateAsync({ algorithmId, xAxis, yAxis, x: cell.x, y: cell.y });
    setIsApplied(true);
    setTimeout(() => setIsApplied(false), 4000);
  }

  return (
    <Surface elevation="low" className="p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Selected cell</p>
          <p className="text-sm font-semibold tabular-nums mt-0.5">
            {AXES[yAxis].label}={fmtAxisValue(cell.y, yAxis)} ·{" "}
            {AXES[xAxis].label}={fmtAxisValue(cell.x, xAxis)}
          </p>
        </div>
        <ApplyButton
          enabled={!liveTradingEnabled}
          pending={apply.isPending}
          isApplied={isApplied}
          onApply={handleApply}
        />
      </div>
      {apply.error && <p className="text-xs text-[var(--loss)]">{apply.error.message}</p>}
      {liveTradingEnabled && (
        <p className="text-xs text-muted-foreground">
          Live trading is on — apply is disabled. Pause live or set <code>live_trading_enabled=false</code> first.
        </p>
      )}

      <AggregateStats cell={cell} />
      {years.length > 0 && <PerYearTable cell={cell} years={years} />}
    </Surface>
  );
}

function AggregateStats({ cell }: { cell: GeometryCell }) {
  return (
    <div className="space-y-1">
      <h4 className="text-[10px] uppercase tracking-wide text-muted-foreground">Aggregate</h4>
      <div className="grid grid-cols-2 gap-y-1 text-xs">
        <span className="text-muted-foreground">Total P&L</span>
        <span className={cn("tabular-nums text-right", pnlColorClass(cell.total_return))}>
          {formatPnl(cell.total_return)}
        </span>
        <span className="text-muted-foreground">Trades</span>
        <span className="tabular-nums text-right">{cell.total_trades}</span>
        <span className="text-muted-foreground">Avg / trade</span>
        <span className={cn("tabular-nums text-right", pnlColorClass(cell.avg_pnl))}>
          {formatPnl(cell.avg_pnl)}
        </span>
        <span className="text-muted-foreground">Win rate</span>
        <span className="tabular-nums text-right">{cell.win_rate.toFixed(1)}%</span>
        <span className="text-muted-foreground">Max DD</span>
        <span className="tabular-nums text-right">{cell.max_drawdown.toFixed(2)}%</span>
        <span className="text-muted-foreground" title="total_return / max_drawdown% — risk-adjusted return">
          Calmar
        </span>
        <span className="tabular-nums text-right">{cell.calmar?.toFixed(2) ?? "—"}</span>
      </div>
    </div>
  );
}

function PerYearTable({ cell, years }: { cell: GeometryCell; years: string[] }) {
  const avgTrades = years.reduce((s, y) => s + cell.per_year[y].trades, 0) / years.length;
  const avgPnl = years.reduce((s, y) => s + cell.per_year[y].pnl, 0) / years.length;
  const avgWr = years.reduce((s, y) => s + cell.per_year[y].win_pct, 0) / years.length;
  return (
    <div className="space-y-1">
      <h4 className="text-[10px] uppercase tracking-wide text-muted-foreground">Per year</h4>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-muted-foreground">
            <th className="text-left font-normal pb-1">Year</th>
            <th className="text-right font-normal pb-1">Trades</th>
            <th className="text-right font-normal pb-1">P&L</th>
            <th className="text-right font-normal pb-1">WR</th>
          </tr>
        </thead>
        <tbody className="font-mono tabular-nums">
          {years.map((y) => {
            const r = cell.per_year[y];
            return (
              <tr key={y} className="border-t border-muted/40">
                <td className="py-1">{y}</td>
                <td className="text-right py-1">{r.trades}</td>
                <td className={cn("text-right py-1", pnlColorClass(r.pnl))}>{formatPnl(r.pnl)}</td>
                <td className="text-right py-1">{r.win_pct.toFixed(0)}%</td>
              </tr>
            );
          })}
          <tr className="border-t-2 border-muted/60 text-muted-foreground font-medium">
            <td className="py-1">Avg</td>
            <td className="text-right py-1">{avgTrades.toFixed(1)}</td>
            <td className={cn("text-right py-1", pnlColorClass(avgPnl))}>{formatPnl(avgPnl)}</td>
            <td className="text-right py-1">{avgWr.toFixed(0)}%</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

// keep DataRow imported for parity with sibling components (unused for now)
void DataRow;

function ApplyButton({
  enabled,
  pending,
  isApplied,
  onApply,
}: {
  enabled: boolean;
  pending: boolean;
  isApplied: boolean;
  onApply: () => void;
}) {
  if (isApplied) {
    return (
      <Button size="sm" disabled>
        <CheckCircle2 className="mr-1.5 h-3.5 w-3.5 text-[var(--profit)]" />
        Applied
      </Button>
    );
  }
  if (pending) {
    return (
      <Button size="sm" disabled>
        <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
        Applying…
      </Button>
    );
  }
  return (
    <Button size="sm" onClick={onApply} disabled={!enabled}>
      Apply to paper
    </Button>
  );
}
