"use client";

import Link from "next/link";
import { AlertCircle, ArrowRight, CheckCircle2, Layers, ShieldQuestion, TrendingUp } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useAlgoSearchState } from "@/hooks/use-algo-search-state";
import type { SearchSingleton, SearchState, SearchSurvivor, SearchTopBlocker } from "@/lib/algo-search/state";

export function SearchTab() {
  const { data, isLoading, isError, error } = useAlgoSearchState();

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Quant-firm-grade systematic search across the locked universe (4 instruments × 3 timeframes
        × 14 pattern primitives × 2 directions). v2 acceptance criteria at{" "}
        <code>scripts/canonical/algo-search.spec.md</code> §4: per-candidate floor is{" "}
        <strong>mean R CI lower &gt; 0</strong> (replaces v1 WR ≥ 37 + Bonferroni); pattern
        robustness requires <strong>≥ 2 cells of same (pattern × direction)</strong> passing
        per-candidate criteria. Operator launches the sweep via{" "}
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
          <SurvivorsCard survivors={data.survivors} />
          {data.singleton_candidates.length > 0 && (
            <SingletonsCard singletons={data.singleton_candidates} />
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

function survivorHint(survivor: number, perCandidatePass: number): string | undefined {
  if (survivor === 0 && perCandidatePass === 0) return "0 candidates pass per-candidate criteria";
  if (survivor === 0) return `${perCandidatePass} pass per-cand criteria but none in robust groups`;
  return `from ${perCandidatePass} per-candidate passing cells`;
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
        label="Robust survivors"
        value={String(state.survivor_count)}
        hint={survivorHint(state.survivor_count, state.per_candidate_pass_count)}
        emphasis={state.survivor_count > 0}
      />
      <StatCard
        icon={ShieldQuestion}
        label="Singletons (per-cand pass, not robust)"
        value={String(state.singleton_count)}
        hint={
          state.singleton_count > 0
            ? "Pattern works on only 1 cell → likely lucky; manual review at acceptance"
            : "No flagged singletons"
        }
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

function SurvivorsCard({ survivors }: { survivors: SearchSurvivor[] }) {
  if (survivors.length === 0) return null;
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium">Robust survivors (per-candidate pass + pattern robust)</CardTitle>
        <p className="text-xs text-muted-foreground">
          Sorted desc by total_return. Each row passes criteria 1–8 (per-candidate floors) AND
          criterion 9 (pattern robustness: ≥ 2 cells of same pattern × direction in pass set), OR
          is on the structural-exemption list (e.g. asian_range_break is 4h-only by enumeration).
          Geometry refinement (Layer B) sweeps each across 96 variants next.
        </p>
      </CardHeader>
      <CardContent className="p-0 overflow-x-auto">
        <SurvivorTable rows={survivors} showRobustnessTag />
      </CardContent>
    </Card>
  );
}

function SingletonsCard({ singletons }: { singletons: SearchSingleton[] }) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium">Singletons — per-candidate pass, robustness FAIL</CardTitle>
        <p className="text-xs text-muted-foreground">
          These cells pass all per-candidate criteria but their pattern × direction works on
          only ONE (instrument, TF) cell. Per spec §4 criterion 9, single-cell wins are likely
          lucky rather than structural edges. Surfaced for operator review at acceptance — NOT
          auto-treated as survivors.
        </p>
      </CardHeader>
      <CardContent className="p-0 overflow-x-auto">
        <SurvivorTable rows={singletons} showRobustnessTag={false} />
      </CardContent>
    </Card>
  );
}

function SurvivorTable({ rows, showRobustnessTag }: { rows: SearchSurvivor[]; showRobustnessTag: boolean }) {
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
          {showRobustnessTag && <th className="text-left p-2.5 font-medium">robustness</th>}
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
            {showRobustnessTag && (
              <td className="p-2.5">
                <Badge
                  variant={s.robustness_status === "robust" ? "default" : "outline"}
                  className="text-[10px] whitespace-nowrap"
                >
                  {s.robustness_status}
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
