"use client";

import { useState } from "react";
import { Activity, AlertCircle, Bot, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useEngineActivity } from "@/hooks/use-engine-activity";
import type { AlgoActivity, NotableSave } from "@/lib/cohort/engine-activity";

const WINDOWS: { label: string; days: number }[] = [
  { label: "24h", days: 1 },
  { label: "3d", days: 3 },
  { label: "7d", days: 7 },
  { label: "30d", days: 30 },
];

export default function ReportsPage() {
  const [days, setDays] = useState(7);
  const { data, isLoading, isError, error } = useEngineActivity(days);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Reports</h1>
          <p className="text-sm text-muted-foreground">
            Engine activity — LLM decisions, gate refusals, and notable saves over the selected
            window. Same source of truth as <code>scripts/cohort-report.ts</code>.
          </p>
        </div>
        <WindowToggle value={days} onChange={setDays} />
      </div>

      {isLoading && (
        <div className="grid gap-4 sm:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-32 w-full rounded-lg" />
          ))}
        </div>
      )}

      {isError && (
        <Card>
          <CardContent className="p-4 flex items-start gap-3 text-sm">
            <AlertCircle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
            <div>
              <p className="font-medium">Failed to load engine activity</p>
              <p className="text-muted-foreground mt-1">
                {error instanceof Error ? error.message : "Unknown error"}
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {data && !isLoading && (
        <>
          <SummaryRow data={data} />
          <PerAlgoTable rows={data.per_algo} />
          {data.notable_saves.length > 0 && (
            <NotableSavesCard saves={data.notable_saves} />
          )}
          {data.per_algo.every((a) => a.evaluations === 0) && (
            <Card>
              <CardContent className="p-4 text-sm text-muted-foreground">
                No algorithm activity in the selected window. Either the scan cron hasn&apos;t fired
                yet or all algorithms are paused. Check the activity log on each algo&apos;s detail
                page for raw events.
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

function WindowToggle({ value, onChange }: { value: number; onChange: (d: number) => void }) {
  return (
    <div className="flex items-center rounded-md border bg-background overflow-hidden">
      {WINDOWS.map((w) => (
        <button
          key={w.days}
          type="button"
          onClick={() => onChange(w.days)}
          className={`px-2.5 py-1 text-xs transition-colors ${
            value === w.days ? "bg-muted font-medium" : "hover:bg-muted/40"
          }`}
        >
          {w.label}
        </button>
      ))}
    </div>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  hint,
}: {
  icon: typeof Bot;
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <Card>
      <CardContent className="p-4 space-y-1.5">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Icon className="h-3.5 w-3.5" />
          {label}
        </div>
        <p className="text-2xl font-semibold">{value}</p>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </CardContent>
    </Card>
  );
}

function DecisionMixCard({
  byDecision,
  byMtf,
}: {
  byDecision: Record<string, number>;
  byMtf: Record<string, number>;
}) {
  return (
    <Card>
      <CardContent className="p-4 space-y-1.5">
        <div className="text-xs text-muted-foreground">Decision mix</div>
        <div className="flex flex-wrap gap-1.5">
          {Object.entries(byDecision)
            .sort((a, b) => b[1] - a[1])
            .map(([k, v]) => (
              <Badge key={k} variant="outline" className="text-xs">
                {k}: {v}
              </Badge>
            ))}
          {Object.keys(byDecision).length === 0 && (
            <span className="text-xs text-muted-foreground">no decisions yet</span>
          )}
        </div>
        {Object.keys(byMtf).length > 0 && (
          <div className="pt-1.5 text-xs text-muted-foreground space-x-2">
            <span className="font-medium">mtf:</span>
            {Object.entries(byMtf)
              .sort((a, b) => b[1] - a[1])
              .map(([k, v]) => (
                <span key={k}>
                  {k}={v}
                </span>
              ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function SummaryRow({
  data,
}: {
  data: {
    llm_decisions: number;
    llm_avg_confidence: number | null;
    llm_by_decision: Record<string, number>;
    llm_by_mtf: Record<string, number>;
    notable_saves: NotableSave[];
    per_algo: AlgoActivity[];
  };
}) {
  const totalEvals = data.per_algo.reduce((s, a) => s + a.evaluations, 0);
  const totalFires = data.per_algo.reduce((s, a) => s + a.fires, 0);
  const totalGateRefusals = data.per_algo.reduce((s, a) => s + a.gate_refusals, 0);

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <StatCard
        icon={Bot}
        label="LLM decisions"
        value={String(data.llm_decisions)}
        hint={
          data.llm_avg_confidence != null
            ? `avg confidence ${data.llm_avg_confidence}%`
            : undefined
        }
      />
      <StatCard
        icon={Activity}
        label="Scan evaluations"
        value={totalEvals.toLocaleString()}
        hint={`${totalFires} entry fires`}
      />
      <StatCard
        icon={ShieldCheck}
        label="Gate refusals"
        value={totalGateRefusals.toLocaleString()}
        hint="market_state_gate triggers"
      />
      <DecisionMixCard byDecision={data.llm_by_decision} byMtf={data.llm_by_mtf} />
    </div>
  );
}

function PerAlgoTable({ rows }: { rows: AlgoActivity[] }) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium">Per-algo activity</CardTitle>
      </CardHeader>
      <CardContent className="p-0 overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="border-b text-muted-foreground">
            <tr>
              <th className="text-left p-2.5 font-medium">algo</th>
              <th className="text-right p-2.5 font-medium">evals</th>
              <th className="text-right p-2.5 font-medium" title="market_state_gate refusals">
                gate
              </th>
              <th className="text-right p-2.5 font-medium" title="entry condition misses">
                cond
              </th>
              <th className="text-right p-2.5 font-medium" title="live_price drift refusals">
                drift
              </th>
              <th className="text-right p-2.5 font-medium" title="bar staleness refusals">
                stale
              </th>
              <th className="text-right p-2.5 font-medium" title="LLM hold decisions">
                holds
              </th>
              <th className="text-right p-2.5 font-medium">other</th>
              <th className="text-right p-2.5 font-medium" title="entry fires">
                fires
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((a) => (
              <tr key={a.algorithm_id} className="border-b last:border-b-0 hover:bg-muted/30">
                <td className="p-2.5 font-medium truncate max-w-[280px]">{a.name}</td>
                <td className="p-2.5 text-right tabular-nums">{a.evaluations}</td>
                <td className="p-2.5 text-right tabular-nums">{a.gate_refusals}</td>
                <td className="p-2.5 text-right tabular-nums">{a.condition_misses}</td>
                <td className="p-2.5 text-right tabular-nums">{a.drift_refusals}</td>
                <td className="p-2.5 text-right tabular-nums">{a.bar_staleness_refusals}</td>
                <td className="p-2.5 text-right tabular-nums">{a.llm_holds}</td>
                <td className="p-2.5 text-right tabular-nums">{a.other_refusals}</td>
                <td className="p-2.5 text-right tabular-nums font-medium">{a.fires}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

function NotableSavesCard({ saves }: { saves: NotableSave[] }) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <ShieldCheck className="h-4 w-4" />
          Notable saves
          <Badge variant="secondary" className="text-xs ml-1">
            {saves.length}
          </Badge>
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Drift refusals where the gate caught a stale-price entry the LLM wanted to take.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {saves.map((s, i) => (
          <div key={`${s.when}-${i}`} className="border-l-2 border-l-primary/40 pl-3 space-y-1">
            <div className="flex items-center gap-2 text-xs">
              <span className="text-muted-foreground tabular-nums">
                {s.when.slice(0, 16)}Z
              </span>
              <span className="font-medium">{s.algorithm}</span>
              {s.confidence != null && (
                <Badge variant="outline" className="text-xs">
                  conf {s.confidence}
                </Badge>
              )}
              {s.would_have_entered_side && (
                <Badge variant="secondary" className="text-xs">
                  would-have-{s.would_have_entered_side}
                </Badge>
              )}
            </div>
            {s.llm_reasoning && (
              <p className="text-xs text-muted-foreground line-clamp-2">
                &ldquo;{s.llm_reasoning}&rdquo;
              </p>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

