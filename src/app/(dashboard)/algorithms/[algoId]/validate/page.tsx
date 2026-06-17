"use client";

import { use, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Loader2, Play } from "lucide-react";
import type { GeometryCell } from "@/app/(dashboard)/algorithms/[algoId]/validate/actions";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { CellDetail } from "@/components/validate/cell-detail";
import { GridHeatmap } from "@/components/validate/grid-heatmap";
import { ValidateTabs, type ValidateTab } from "@/components/validate/validate-tabs";
import { useAlgorithm } from "@/hooks/use-algorithms";
import { useGeometrySweep, useRunGeometrySweep } from "@/hooks/use-geometry-sweep";

export default function ValidatePage({ params }: { params: Promise<{ algoId: string }> }) {
  const { algoId } = use(params);
  const [tab, setTab] = useState<ValidateTab>("grid");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const { data: algo } = useAlgorithm(algoId);
  const sweepQ = useGeometrySweep(algoId);
  const run = useRunGeometrySweep();

  const sweep = sweepQ.data ?? null;
  const ddBreachThreshold =
    (algo?.rules as unknown as { prop_firm?: { max_drawdown?: number } } | undefined)?.prop_firm
      ?.max_drawdown ?? null;
  const liveOn = (algo as { live_trading_enabled?: boolean } | undefined)?.live_trading_enabled === true;
  const selected: GeometryCell | null =
    selectedKey != null && sweep
      ? sweep.cells.find((c) => `${c.rr}-${c.lookback}` === selectedKey) ?? null
      : null;

  return (
    <div className="space-y-4">
      <Header algoId={algoId} algoName={algo?.name ?? null} />
      <ValidateTabs active={tab} onChange={setTab} />

      {tab === "grid" && (
        <div className="space-y-4">
          <RunBar
            algoId={algoId}
            ranAt={sweep?.ran_at ?? null}
            isPending={run.isPending}
            error={run.error?.message ?? null}
            onRun={() => run.mutate(algoId)}
          />
          {sweepQ.isLoading && <Skeleton className="h-48 w-full rounded-md" />}
          {!sweepQ.isLoading && !sweep && !run.isPending && <EmptyState />}
          {sweep && (
            <div className="grid gap-4 lg:grid-cols-[2fr_minmax(280px,360px)]">
              <GridHeatmap
                sweep={sweep}
                selectedKey={selectedKey}
                onSelect={(c) => setSelectedKey(`${c.rr}-${c.lookback}`)}
                ddBreachThreshold={ddBreachThreshold}
              />
              {selected ? (
                <CellDetail
                  key={`${algoId}-${selected.rr}-${selected.lookback}`}
                  algorithmId={algoId}
                  cell={selected}
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
    <div className="flex items-start justify-between gap-3">
      <div>
        <Button size="xs" variant="ghost" className="-ml-2 mb-1 h-7" render={<Link href={`/algorithms/${algoId}`} />} nativeButton={false}>
          <ArrowLeft className="mr-1 h-3.5 w-3.5" /> Algorithm
        </Button>
        <h1 className="text-2xl font-semibold tracking-tight">Validate</h1>
        <p className="text-sm text-muted-foreground">
          {algoName ?? "—"} · pre-deploy / re-validation gauntlet.
        </p>
      </div>
    </div>
  );
}

function RunBar({
  algoId,
  ranAt,
  isPending,
  error,
  onRun,
}: {
  algoId: string;
  ranAt: string | null;
  isPending: boolean;
  error: string | null;
  onRun: () => void;
}) {
  return (
    <Card>
      <CardContent className="p-3 flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          {ranAt
            ? `Last run ${new Date(ranAt).toLocaleString()} — 9 cells (RR ∈ {2,3,5} × lb ∈ {3,4,6})`
            : "No sweep yet. Click below to run all 9 cells across full history."}
        </p>
        <Button size="sm" onClick={onRun} disabled={isPending} title={`Algo: ${algoId}`}>
          {isPending ? (
            <>
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> Running 9 cells…
            </>
          ) : (
            <>
              <Play className="mr-1.5 h-3.5 w-3.5" /> {ranAt ? "Re-run sweep" : "Run sweep"}
            </>
          )}
        </Button>
        {error && <p className="text-xs text-[var(--loss)] w-full">{error}</p>}
      </CardContent>
    </Card>
  );
}

function EmptyState() {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs text-muted-foreground">
          Run the sweep to populate the heatmap. Each cell runs a full-history backtest with the
          algorithm&apos;s rules cloned to use that RR/lookback combination — same engine + same
          prop_firm gates as live. ~30-90s end to end.
        </p>
      </CardContent>
    </Card>
  );
}
