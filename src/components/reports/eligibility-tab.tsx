"use client";

import Link from "next/link";
import { AlertCircle, ArrowRight, CheckCircle2, Clock, TrendingUp } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useLiveMirrorEligibility } from "@/hooks/use-live-mirror-eligibility";
import type {
  AlgoEligibility,
  EligibilityStatus,
} from "@/lib/cohort/live-mirror-eligibility";

const STATUS_META: Record<
  EligibilityStatus,
  { label: string; variant: "default" | "secondary" | "destructive" | "outline" }
> = {
  eligible: { label: "Eligible", variant: "default" },
  drift: { label: "Drift", variant: "destructive" },
  pending: { label: "Pending", variant: "secondary" },
  no_backtest: { label: "No backtest", variant: "outline" },
};

export function EligibilityTab() {
  const { data, isLoading, isError, error } = useLiveMirrorEligibility();

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Paper→live promotion milestone (per <code>feedback_live_mirror_milestone</code>): a paper
        algo needs <strong>15+ days deployed</strong>, <strong>5+ closed trades</strong>, and
        realized mean R within <strong>±50% of backtest expected R</strong>. This catches live-
        execution drift before any real money is risked.
      </p>

      {isLoading && (
        <div className="grid gap-4 sm:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-24 w-full rounded-lg" />
          ))}
        </div>
      )}

      {isError && (
        <Card>
          <CardContent className="p-4 flex items-start gap-3 text-sm">
            <AlertCircle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
            <div>
              <p className="font-medium">Failed to load eligibility</p>
              <p className="text-muted-foreground mt-1">
                {error instanceof Error ? error.message : "Unknown error"}
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {data && !isLoading && (
        <>
          <SummaryRow rows={data} />
          {data.length === 0 ? (
            <Card>
              <CardContent className="p-4 text-sm text-muted-foreground">
                No paper algos to evaluate. All active algos are either live-trading-enabled or
                paused.
              </CardContent>
            </Card>
          ) : (
            <EligibilityTable rows={data} />
          )}
        </>
      )}
    </div>
  );
}

function SummaryRow({ rows }: { rows: AlgoEligibility[] }) {
  const eligible = rows.filter((r) => r.status === "eligible").length;
  const drift = rows.filter((r) => r.status === "drift").length;
  const pending = rows.filter((r) => r.status === "pending").length;
  const noBacktest = rows.filter((r) => r.status === "no_backtest").length;

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <StatCard
        icon={CheckCircle2}
        label="Eligible to promote"
        value={String(eligible)}
        hint={eligible > 0 ? "Action: review then flip live_trading_enabled" : "None yet"}
        emphasis={eligible > 0}
      />
      <StatCard
        icon={TrendingUp}
        label="Drift"
        value={String(drift)}
        hint={drift > 0 ? "Live R diverges from backtest — investigate" : undefined}
        emphasis={drift > 0}
      />
      <StatCard icon={Clock} label="Pending" value={String(pending)} hint="Time or trades to go" />
      <StatCard
        icon={AlertCircle}
        label="No backtest"
        value={String(noBacktest)}
        hint="Backtest_results missing or sizing not risk_per_trade"
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
  icon: typeof Clock;
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
        <p className="text-2xl font-semibold">{value}</p>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </CardContent>
    </Card>
  );
}

function fmtR(r: number | null): string {
  if (r == null) return "—";
  return r.toFixed(2);
}

function fmtVariance(v: number | null): string {
  if (v == null) return "—";
  return `${(v * 100).toFixed(0)}%`;
}

function EligibilityRow({ r }: { r: AlgoEligibility }) {
  return (
    <tr className="border-b last:border-b-0 hover:bg-muted/30">
      <td className="p-2.5 max-w-[280px]">
        <div className="font-medium truncate">{r.name}</div>
        {r.strategy_name && (
          <div className="text-muted-foreground text-[10px] truncate">{r.strategy_name}</div>
        )}
      </td>
      <td className="p-2.5 text-right tabular-nums">{r.days_since_deploy}</td>
      <td className="p-2.5 text-right tabular-nums">{r.closed_trade_count}</td>
      <td className="p-2.5 text-right tabular-nums">{fmtR(r.realized_mean_r)}</td>
      <td className="p-2.5 text-right tabular-nums">{fmtR(r.backtest_expected_r)}</td>
      <td className="p-2.5 text-right tabular-nums">{fmtVariance(r.variance_ratio)}</td>
      <td className="p-2.5">
        <Badge variant={STATUS_META[r.status].variant} className="text-[10px] whitespace-nowrap">
          {STATUS_META[r.status].label}
        </Badge>
      </td>
      <td className="p-2.5 text-muted-foreground max-w-[260px]">
        <div className="truncate" title={r.reasons.join(" · ")}>
          {r.reasons.join(" · ")}
        </div>
      </td>
      <td className="p-2.5">
        <Button
          size="sm"
          variant="ghost"
          render={<Link href={`/algorithms/${r.algorithm_id}`} />}
          nativeButton={false}
          className="h-7 px-2"
        >
          Open <ArrowRight className="ml-1 h-3 w-3" />
        </Button>
      </td>
    </tr>
  );
}

function EligibilityTable({ rows }: { rows: AlgoEligibility[] }) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium">Paper algos</CardTitle>
        <p className="text-xs text-muted-foreground">
          Sorted: eligible first, then drift, then pending by closest-to-milestone.
        </p>
      </CardHeader>
      <CardContent className="p-0 overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="border-b text-muted-foreground">
            <tr>
              <th className="text-left p-2.5 font-medium">algo</th>
              <th className="text-right p-2.5 font-medium" title="Days since deploy">days</th>
              <th className="text-right p-2.5 font-medium" title="Closed paper trades">trades</th>
              <th className="text-right p-2.5 font-medium" title="Realized mean R per trade">realized R</th>
              <th className="text-right p-2.5 font-medium" title="Backtest expected R per trade">expected R</th>
              <th className="text-right p-2.5 font-medium" title="realized / expected">variance</th>
              <th className="text-left p-2.5 font-medium">status</th>
              <th className="text-left p-2.5 font-medium">why</th>
              <th className="p-2.5" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <EligibilityRow key={r.algorithm_id} r={r} />
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}
