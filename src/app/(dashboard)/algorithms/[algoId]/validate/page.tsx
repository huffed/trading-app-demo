"use client";

import { use, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Loader2, Play } from "lucide-react";
import {
  AXES,
  DEFAULT_X_AXIS,
  DEFAULT_Y_AXIS,
  type AxisKey,
  type GeometryCell,
  type GeometrySweep,
} from "@/app/(dashboard)/algorithms/[algoId]/validate/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { CellDetail } from "@/components/validate/cell-detail";
import { GridHeatmap } from "@/components/validate/grid-heatmap";
import { ValidateTabs, type ValidateTab } from "@/components/validate/validate-tabs";
import { useAlgorithm } from "@/hooks/use-algorithms";
import { useGeometrySweep, useRunGeometrySweep } from "@/hooks/use-geometry-sweep";

const AXIS_OPTIONS = Object.values(AXES);

export default function ValidatePage({ params }: { params: Promise<{ algoId: string }> }) {
  const { algoId } = use(params);
  const [tab, setTab] = useState<ValidateTab>("grid");
  const [xAxis, setXAxis] = useState<AxisKey>(DEFAULT_X_AXIS);
  const [yAxis, setYAxis] = useState<AxisKey>(DEFAULT_Y_AXIS);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const { data: algo } = useAlgorithm(algoId);
  const sweepQ = useGeometrySweep(algoId);
  const run = useRunGeometrySweep();

  const sweep = sweepQ.data ?? null;
  // CB.H3 (2026-06-20): algo from useAlgorithm() is already typed Algorithm
  // via algorithmFromRow mapper — drop the inline rule-shape casts.
  const ddBreachThreshold = algo?.rules?.prop_firm?.max_drawdown ?? null;
  const liveOn = algo?.live_trading_enabled === true;
  const selected: GeometryCell | null =
    selectedKey != null && sweep
      ? sweep.cells.find((c) => `${String(c.x)}-${String(c.y)}` === selectedKey) ?? null
      : null;
  // Use the sweep's recorded axes when rendering — so the detail panel
  // matches the heatmap even if the user has changed the dropdowns
  // since the sweep was run.
  const sweepXAxis = sweep?.x_axis ?? xAxis;
  const sweepYAxis = sweep?.y_axis ?? yAxis;

  return (
    <div className="space-y-4">
      <Header algoId={algoId} algoName={algo?.name ?? null} />
      <ValidateTabs active={tab} onChange={setTab} />

      {tab === "grid" && (
        <div className="space-y-4">
          <RunBar
            xAxis={xAxis}
            yAxis={yAxis}
            onXChange={setXAxis}
            onYChange={setYAxis}
            sweep={sweep}
            isPending={run.isPending}
            error={run.error?.message ?? null}
            onRun={() => run.mutate({ algorithmId: algoId, xAxis, yAxis })}
          />
          {sweepQ.isLoading && <Skeleton className="h-48 w-full rounded-md" />}
          {!sweepQ.isLoading && !sweep && !run.isPending && <EmptyState />}
          {sweep && (
            <div className="grid gap-4 lg:grid-cols-[2fr_minmax(280px,360px)]">
              <GridHeatmap
                sweep={sweep}
                selectedKey={selectedKey}
                onSelect={(c) => setSelectedKey(`${String(c.x)}-${String(c.y)}`)}
                ddBreachThreshold={ddBreachThreshold}
              />
              {selected ? (
                <CellDetail
                  key={`${algoId}-${selectedKey}`}
                  algorithmId={algoId}
                  cell={selected}
                  xAxis={sweepXAxis}
                  yAxis={sweepYAxis}
                  liveTradingEnabled={liveOn}
                />
              ) : (
                <Card>
                  <CardContent className="p-4">
                    <p className="text-xs text-muted-foreground">
                      Click a cell to see its per-year decomposition and apply the config to paper.
                    </p>
                  </CardContent>
                </Card>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Header({ algoId, algoName }: { algoId: string; algoName: string | null }) {
  return (
    <div>
      <Button size="xs" variant="ghost" className="-ml-2 mb-1 h-7" render={<Link href={`/algorithms/${algoId}`} />} nativeButton={false}>
        <ArrowLeft className="mr-1 h-3.5 w-3.5" /> Algorithm
      </Button>
      <h1 className="text-2xl font-semibold tracking-tight">Validate</h1>
      <p className="text-sm text-muted-foreground">
        {algoName ?? "—"} · pre-deploy / re-validation gauntlet.
      </p>
    </div>
  );
}

function AxisPicker({
  label,
  value,
  exclude,
  onChange,
}: {
  label: string;
  value: AxisKey;
  exclude: AxisKey;
  onChange: (k: AxisKey) => void;
}) {
  return (
    <div className="space-y-1 min-w-[140px]">
      <Label className="text-xs">{label}</Label>
      <Select value={value} onValueChange={(v) => v && onChange(v as AxisKey)}>
        <SelectTrigger className="w-full">
          <SelectValue>{AXES[value].label}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {AXIS_OPTIONS.filter((a) => a.key !== exclude).map((a) => (
            <SelectItem key={a.key} value={a.key}>
              {a.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function RunBar({
  xAxis,
  yAxis,
  onXChange,
  onYChange,
  sweep,
  isPending,
  error,
  onRun,
}: {
  xAxis: AxisKey;
  yAxis: AxisKey;
  onXChange: (k: AxisKey) => void;
  onYChange: (k: AxisKey) => void;
  sweep: GeometrySweep | null;
  isPending: boolean;
  error: string | null;
  onRun: () => void;
}) {
  return (
    <Card>
      <CardContent className="p-3 space-y-2">
        <div className="flex flex-wrap items-end gap-3">
          <AxisPicker label="Y axis" value={yAxis} exclude={xAxis} onChange={onYChange} />
          <span className="text-muted-foreground pb-2">×</span>
          <AxisPicker label="X axis" value={xAxis} exclude={yAxis} onChange={onXChange} />
          <div className="flex-1" />
          <Button size="sm" onClick={onRun} disabled={isPending}>
            {isPending ? (
              <>
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> Running…
              </>
            ) : (
              <>
                <Play className="mr-1.5 h-3.5 w-3.5" /> {sweep ? "Re-run sweep" : "Run sweep"}
              </>
            )}
          </Button>
        </div>
        {sweep && (
          <p className="text-[10px] text-muted-foreground">
            Last run {new Date(sweep.ran_at).toLocaleString()} — {sweep.cells.length} cells
            ({AXES[sweep.y_axis].label} × {AXES[sweep.x_axis].label})
          </p>
        )}
        {error && <p className="text-xs text-[var(--loss)]">{error}</p>}
      </CardContent>
    </Card>
  );
}

function EmptyState() {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs text-muted-foreground">
          Pick two axes above and click Run sweep. Each cell runs a full-history backtest with the
          algorithm&apos;s rules cloned for that combination — engine + prop_firm gates match live.
          The 7 unselected axes stay at the algorithm&apos;s deployed values; their snapshot shows
          below the heatmap after the run.
        </p>
      </CardContent>
    </Card>
  );
}
