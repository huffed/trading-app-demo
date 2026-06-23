"use client";

import Link from "next/link";
import { AlertCircle, ArrowRight, CheckCircle2, Layers, ShieldQuestion, TrendingUp } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useAlgoSearchState } from "@/hooks/use-algo-search-state";
import type { LayerBVariantRow, SearchState, SearchSurvivor, SearchTopBlocker } from "@/lib/algo-search/state";

export function SearchTab() {
  const { data, isLoading, isError, error } = useAlgoSearchState();

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Quant-firm-grade systematic search across the locked universe (4 instruments × 3 timeframes
        × 14 pattern primitives × 2 directions). Active acceptance criteria at{" "}
        <code>scripts/canonical/algo-search.spec.md</code> §4: per-candidate floor is{" "}
        <strong>mean R CI lower &gt; 0</strong> (criteria 1–7), and ship-readiness requires the
        deflated trinity (criteria 8–10: <strong>DSR ≥ 0.95 + PBO &lt; 0.5 + purged k-fold ≥
        4/5</strong>). Operator launches the sweep via{" "}
        <code>MODE=full pnpm dlx tsx scripts/canonical/algo-search.ts</code> — this tab is read-only.
      </p>

      {isLoading && <SearchSkeleton />}

      {isError && (
        <Card>
          <CardContent className="p-4 flex items-start gap-3 text-sm">
            <AlertCircle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
            <div>
              <p className="font-medium">Failed to load search state</p>
              <p className="text-muted-foreground mt-1">
                {error instanceof Error ? error.message : "Unknown error"}
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {data && !isLoading && (
        <>
          <SummaryRow state={data} />
          <UniverseCard state={data} />
          {data.evaluated_count > 0 && <BlockersCard blockers={data.blockers} evaluated={data.evaluated_count} />}
          <SurvivorsCard survivors={data.survivors} shipReadyCount={data.ship_ready_count} />
          {data.layer_b_variants.length > 0 && (
            <LayerBVariantsCard variants={data.layer_b_variants} />
          )}
          <EmptyStateHint state={data} />
        </>
      )}
    </div>
  );
}

function evaluatedHint(inserted: number, evaluated: number): string {
  if (inserted === 0) return "No candidates inserted yet — run MODE=full";
  if (evaluated < inserted) return `${inserted - evaluated} inserted but unscored`;
  return "All inserted rows have backtest_results";
}


function SearchSkeleton() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {Array.from({ length: 4 }).map((_, i) => (
        <Skeleton key={i} className="h-24 w-full rounded-lg" />
      ))}
    </div>
  );
}

function SummaryRow({ state }: { state: SearchState }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <StatCard
        icon={Layers}
        label="Universe (Layer A cells)"
        value={String(state.enumerated_count)}
        hint={`${state.inserted_count} inserted as drafts`}
      />
      <StatCard
        icon={CheckCircle2}
        label="Evaluated"
        value={`${state.evaluated_count} / ${state.inserted_count}`}
        hint={evaluatedHint(state.inserted_count, state.evaluated_count)}
      />
      <StatCard
        icon={TrendingUp}
        label="Per-candidate-pass (Layer A)"
        value={String(state.per_candidate_pass_count)}
        hint={
          state.per_candidate_pass_count === 0 && state.evaluated_count > 0
            ? "All evaluated rows fail ≥1 criterion"
            : "Pass per-candidate criteria 1–7"
        }
      />
      <StatCard
        icon={ShieldQuestion}
        label="Ship-ready (DSR + PBO + k-fold)"
        value={String(state.ship_ready_count)}
        hint={
          state.ship_ready_count > 0
            ? "Pass deflated criteria 8–10 (DSR ≥ 0.95, PBO < 0.5, k-fold ≥ 4/5)"
            : "Requires `revalidate-candidates.ts` to populate deflated block; Layer B variants below carry it"
        }
        emphasis={state.ship_ready_count > 0}
      />
    </div>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  hint,
  emphasis = false,
}: {
  icon: typeof Layers;
  label: string;
  value: string;
  hint?: string;
  emphasis?: boolean;
}) {
  return (
    <Card className={emphasis ? "border-primary/50" : undefined}>
      <CardContent className="p-4 space-y-1.5">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Icon className="h-3.5 w-3.5" />
          {label}
        </div>
        <p className="text-2xl font-semibold tabular-nums">{value}</p>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </CardContent>
    </Card>
  );
}

function UniverseCard({ state }: { state: SearchState }) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium">Search universe</CardTitle>
        <p className="text-xs text-muted-foreground">
          Enumeration is deterministic. The four counts below ALWAYS sum to {state.enumerated_count}.
        </p>
      </CardHeader>
      <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 p-4 pt-0">
        <AxisTally label="By instrument" entries={state.by_instrument} />
        <AxisTally label="By timeframe" entries={state.by_timeframe} />
        <AxisTally label="By side" entries={state.by_side} />
        <AxisTally label="By pattern" entries={state.by_pattern} />
      </CardContent>
    </Card>
  );
}

function AxisTally({ label, entries }: { label: string; entries: Record<string, number> }) {
  const sorted = Object.entries(entries).sort(([a], [b]) => a.localeCompare(b));
  return (
    <div className="space-y-1.5">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className="space-y-0.5 text-xs">
        {sorted.map(([k, v]) => (
          <div key={k} className="flex justify-between border-b border-border/40 last:border-b-0 py-1">
            <span className="text-muted-foreground">{k}</span>
            <span className="tabular-nums font-medium">{v}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function BlockersCard({ blockers, evaluated }: { blockers: SearchTopBlocker[]; evaluated: number }) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium">Top blockers (per-criterion failures)</CardTitle>
        <p className="text-xs text-muted-foreground">
          Of {evaluated} evaluated candidates, how many fail EACH of the 9 pre-registered criteria.
          Sorted desc — the top entry is what&apos;s killing most of the search.
        </p>
      </CardHeader>
      <CardContent className="p-0">
        <table className="w-full text-xs">
          <thead className="border-b text-muted-foreground">
            <tr>
              <th className="text-left p-2.5 font-medium">criterion</th>
              <th className="text-right p-2.5 font-medium">failed_count</th>
              <th className="text-right p-2.5 font-medium">% of evaluated</th>
            </tr>
          </thead>
          <tbody>
            {blockers.map((b) => (
              <tr key={b.key} className="border-b last:border-b-0">
                <td className="p-2.5 font-mono">{b.label}</td>
                <td className="p-2.5 text-right tabular-nums">{b.failed_count}</td>
                <td className="p-2.5 text-right tabular-nums">
                  {evaluated > 0 ? `${Math.round((b.failed_count / evaluated) * 100)}%` : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

function SurvivorsCard({ survivors, shipReadyCount }: { survivors: SearchSurvivor[]; shipReadyCount: number }) {
  if (survivors.length === 0) return null;
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium">
          Per-candidate-pass survivors ({survivors.length}) — of which {shipReadyCount} are ship-ready (DSR + PBO + k-fold)
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Rows passing per-candidate criteria 1–7 (return / trades / DDs / CI lower / OOS). The
          ship-status badge indicates whether deflated criteria 8–10 (DSR ≥ 0.95 + PBO &lt; 0.5 +
          k-fold consistency ≥ 80%) also pass — requires `revalidate-candidates.ts` to have
          populated the deflated block. Most Layer A rows lack the deflated block (it&apos;s applied
          selectively to finalists); the Layer B section below carries deflated stats for the
          geometry-refined variants.
        </p>
      </CardHeader>
      <CardContent className="p-0 overflow-x-auto">
        <SurvivorTable rows={survivors} showShipBadge />
      </CardContent>
    </Card>
  );
}

function LayerBVariantsCard({ variants }: { variants: LayerBVariantRow[] }) {
  const withDeflated = variants.filter((v) => v.deflated !== null);
  const top = variants.slice(0, 20); // cap render to top-20 by total_return
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium">
          Layer B variants ({variants.length}) — geometry-refined; {withDeflated.length} with deflated stats
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Sorted by total_return DESC; top 20 shown. Variants live in the{" "}
          <code>LayerB:</code> namespace (geometry refinement of a Layer A base candidate). The
          deflated columns (DSR / PBO / k-fold consistency) are populated by{" "}
          <code>scripts/canonical/revalidate-candidates.ts</code>; rows show
          <em> &ldquo;—&rdquo;</em> in those columns until that script has been run for them.
        </p>
      </CardHeader>
      <CardContent className="p-0 overflow-x-auto">
        <LayerBTable rows={top} />
      </CardContent>
    </Card>
  );
}

function LayerBTable({ rows }: { rows: LayerBVariantRow[] }) {
  return (
    <table className="w-full text-xs">
      <thead className="border-b text-muted-foreground">
        <tr>
          <th className="text-left p-2.5 font-medium">variant</th>
          <th className="text-right p-2.5 font-medium">trades</th>
          <th className="text-right p-2.5 font-medium">WR</th>
          <th className="text-right p-2.5 font-medium">return</th>
          <th className="text-right p-2.5 font-medium">DD</th>
          <th className="text-right p-2.5 font-medium">CI lower</th>
          <th className="text-right p-2.5 font-medium">Sharpe</th>
          <th className="text-right p-2.5 font-medium">DSR</th>
          <th className="text-right p-2.5 font-medium">PBO</th>
          <th className="text-right p-2.5 font-medium">k-fold</th>
          <th className="p-2.5" />
        </tr>
      </thead>
      <tbody>
        {rows.map((v) => (
          <tr key={v.algorithm_id} className="border-b last:border-b-0 hover:bg-muted/30">
            <td className="p-2.5 max-w-[320px]">
              <div className="font-medium truncate" title={v.name}>
                {v.variant_tag ?? v.name}
              </div>
              {v.base_name && (
                <div className="text-muted-foreground text-[10px] truncate">
                  {v.base_name.replace(/^LayerB:\s*/, "")}
                </div>
              )}
            </td>
            <td className="p-2.5 text-right tabular-nums">{v.total_trades ?? "—"}</td>
            <td className="p-2.5 text-right tabular-nums">{v.win_rate?.toFixed(1) ?? "—"}%</td>
            <td className="p-2.5 text-right tabular-nums">
              {v.total_return != null ? `$${v.total_return.toFixed(0)}` : "—"}
            </td>
            <td className="p-2.5 text-right tabular-nums">
              {v.static_dd != null ? `${v.static_dd.toFixed(2)}%` : "—"}
            </td>
            <td className="p-2.5 text-right tabular-nums">
              {v.mean_r_ci_lower != null ? v.mean_r_ci_lower.toFixed(3) : "—"}
            </td>
            <td className="p-2.5 text-right tabular-nums">
              {v.sharpe_ratio != null ? v.sharpe_ratio.toFixed(2) : "—"}
            </td>
            <td className="p-2.5 text-right tabular-nums">
              {v.deflated ? (
                <Badge
                  variant={v.deflated.deflated_sharpe >= 0.95 ? "default" : "outline"}
                  className="text-[10px]"
                >
                  {v.deflated.deflated_sharpe.toFixed(3)}
                </Badge>
              ) : (
                "—"
              )}
            </td>
            <td className="p-2.5 text-right tabular-nums">
              {v.deflated ? (
                <Badge
                  variant={v.deflated.pbo < 0.5 ? "default" : "outline"}
                  className="text-[10px]"
                >
                  {v.deflated.pbo.toFixed(3)}
                </Badge>
              ) : (
                "—"
              )}
            </td>
            <td className="p-2.5 text-right tabular-nums">
              {v.deflated?.purged_kfold_consistency
                ? `${v.deflated.purged_kfold_consistency.count}/${v.deflated.purged_kfold_consistency.total}`
                : "—"}
            </td>
            <td className="p-2.5">
              <Button
                size="sm"
                variant="ghost"
                render={<Link href={`/algorithms/${v.algorithm_id}`} />}
                nativeButton={false}
                className="h-7 px-2"
              >
                Open <ArrowRight className="ml-1 h-3 w-3" />
              </Button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function SurvivorTable({ rows, showShipBadge }: { rows: SearchSurvivor[]; showShipBadge: boolean }) {
  return (
    <table className="w-full text-xs">
      <thead className="border-b text-muted-foreground">
        <tr>
          <th className="text-left p-2.5 font-medium">algo</th>
          <th className="text-left p-2.5 font-medium">ticker</th>
          <th className="text-left p-2.5 font-medium">pattern</th>
          <th className="text-left p-2.5 font-medium">side</th>
          <th className="text-left p-2.5 font-medium">TF</th>
          <th className="text-right p-2.5 font-medium">trades</th>
          <th className="text-right p-2.5 font-medium">WR</th>
          <th className="text-right p-2.5 font-medium">return</th>
          <th className="text-right p-2.5 font-medium">CI lower</th>
          <th className="text-right p-2.5 font-medium">held-out N</th>
          {showShipBadge && <th className="text-left p-2.5 font-medium">ship status</th>}
          <th className="p-2.5" />
        </tr>
      </thead>
      <tbody>
        {rows.map((s) => (
          <tr key={s.algorithm_id} className="border-b last:border-b-0 hover:bg-muted/30">
            <td className="p-2.5 max-w-[240px]">
              <div className="font-medium truncate" title={s.name}>{s.name}</div>
            </td>
            <td className="p-2.5">{s.ticker}</td>
            <td className="p-2.5">{s.pattern}</td>
            <td className="p-2.5">
              <Badge variant={s.side === "long" ? "default" : "secondary"} className="text-[10px]">
                {s.side}
              </Badge>
            </td>
            <td className="p-2.5">{s.timeframe}</td>
            <td className="p-2.5 text-right tabular-nums">{s.total_trades ?? "—"}</td>
            <td className="p-2.5 text-right tabular-nums">{s.win_rate?.toFixed(1) ?? "—"}%</td>
            <td className="p-2.5 text-right tabular-nums">
              {s.total_return != null ? `$${s.total_return.toFixed(0)}` : "—"}
            </td>
            <td className="p-2.5 text-right tabular-nums">
              {s.mean_r_ci_lower != null ? s.mean_r_ci_lower.toFixed(3) : "—"}
            </td>
            <td className="p-2.5 text-right tabular-nums">{s.oos_held_out_trades ?? "—"}</td>
            {showShipBadge && (
              <td className="p-2.5">
                <Badge
                  variant={s.ship_status === "ship-ready" ? "default" : "outline"}
                  className="text-[10px] whitespace-nowrap"
                >
                  {s.ship_status}
                </Badge>
              </td>
            )}
            <td className="p-2.5">
              <Button
                size="sm"
                variant="ghost"
                render={<Link href={`/algorithms/${s.algorithm_id}`} />}
                nativeButton={false}
                className="h-7 px-2"
              >
                Open <ArrowRight className="ml-1 h-3 w-3" />
              </Button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function EmptyStateHint({ state }: { state: SearchState }) {
  if (state.evaluated_count > 0) return null;
  return (
    <Card>
      <CardContent className="p-4 text-sm text-muted-foreground space-y-2">
        <p className="font-medium text-foreground">No candidates evaluated yet.</p>
        <p>
          The search universe is enumerated ({state.enumerated_count} cells), but no rows have
          been scored. To run the sweep:
        </p>
        <pre className="bg-muted/40 rounded p-2 font-mono text-xs">
          MODE=full pnpm dlx tsx scripts/canonical/algo-search.ts
        </pre>
        <p>
          Wall clock: ~2–4 hours (~30–60s per candidate). Cost: $0 — deterministic backtest, no
          LLM calls. Run overnight; survivors appear on refresh.
        </p>
      </CardContent>
    </Card>
  );
}
