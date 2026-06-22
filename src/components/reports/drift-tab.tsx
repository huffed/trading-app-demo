"use client";

import { AlertCircle, AlertTriangle, CircleSlash, ShieldAlert, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useDriftSummary } from "@/hooks/use-drift-summary";
import type {
  AlgoDriftStatus,
  DriftEvent,
} from "@/lib/cohort/drift-summary";
import type { DriftSeverity } from "@/lib/scan/drift-detector";

/**
 * Drift surface — SG.5 closure (2026-06-22 NIGHT LATE).
 *
 * Two operator-facing sections:
 *
 *  1. Per-algo current drift state — runs `detectDrift` against every
 *     algo with a backtest baseline. Halt rows sort first, then warn,
 *     then none, then no-baseline. Operator sees actionable rows at top.
 *
 *  2. Recent drift events — last N drift_halt/drift_warn rows from
 *     activity_log over the trailing window (default 30d). Diagnostic
 *     surface for "when did drift fire?"
 *
 * Honest scope: a halt severity here ≠ algo currently being halted —
 * the engine halts on the post-close scan that fires detectDrift; THIS
 * surface is what the operator would see ON that scan tick. They match
 * in steady state; mid-tick race the UI may show the pre-execute halt
 * one tick before the algorithms row reflects `live_trading_enabled=
 * false`.
 */
export function DriftTab() {
  const { data, isLoading, isError, error } = useDriftSummary();

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Performance-drift detection — recent live WR / net P&L vs backtest baseline. Severity
        rules from <code>src/lib/scan/drift-detector.ts</code>: <strong>halt</strong> on WR drop
        ≥ 20pp OR sign-flip (backtest +$ but recent −$) OR <code>min_live_wr_pct</code> floor
        breach; <strong>warn</strong> on WR drop ≥ 15pp. Halt severity disables{" "}
        <code>live_trading_enabled</code> on the algorithm; warn logs only.
      </p>

      {isLoading && (
        <div className="grid gap-4 sm:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-24 w-full rounded-lg" />
          ))}
        </div>
      )}

      {isError && (
        <Card>
          <CardContent className="p-4 flex items-start gap-3 text-sm">
            <AlertCircle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
            <div>
              <p className="font-medium">Failed to load drift summary</p>
              <p className="text-muted-foreground mt-1">
                {error instanceof Error ? error.message : "Unknown error"}
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {data && !isLoading && (
        <>
          <SeverityCards counts={data.severity_counts} />
          <PerAlgoCard rows={data.per_algo} />
          <RecentEventsCard events={data.recent_events} history_days={data.history_days} />
        </>
      )}
    </div>
  );
}

function SeverityCards({
  counts,
}: {
  counts: { none: number; warn: number; halt: number; no_baseline: number };
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <SeverityCard
        label="Halt"
        count={counts.halt}
        icon={<ShieldAlert className="h-4 w-4 text-destructive" />}
        accent="text-destructive"
      />
      <SeverityCard
        label="Warn"
        count={counts.warn}
        icon={<AlertTriangle className="h-4 w-4 text-amber-500" />}
        accent="text-amber-500"
      />
      <SeverityCard
        label="None"
        count={counts.none}
        icon={<ShieldCheck className="h-4 w-4 text-emerald-500" />}
        accent="text-emerald-500"
      />
      <SeverityCard
        label="No baseline"
        count={counts.no_baseline}
        icon={<CircleSlash className="h-4 w-4 text-muted-foreground" />}
        accent="text-muted-foreground"
      />
    </div>
  );
}

function SeverityCard({
  label,
  count,
  icon,
  accent,
}: {
  label: string;
  count: number;
  icon: React.ReactNode;
  accent: string;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
          {icon}
          {label}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className={`text-2xl font-semibold tabular-nums ${accent}`}>{count}</p>
      </CardContent>
    </Card>
  );
}

function SeverityBadge({ severity }: { severity: DriftSeverity | "unknown" }) {
  const meta: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
    halt: { label: "halt", variant: "destructive" },
    warn: { label: "warn", variant: "outline" },
    none: { label: "none", variant: "secondary" },
    unknown: { label: "?", variant: "secondary" },
  };
  const m = meta[severity] ?? meta.unknown;
  return <Badge variant={m.variant}>{m.label}</Badge>;
}

function PerAlgoCard({ rows }: { rows: AlgoDriftStatus[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Per-algo current drift state</CardTitle>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No algos deployed.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="py-2 pr-3">Algorithm</th>
                  <th className="py-2 pr-3">Severity</th>
                  <th className="py-2 pr-3">Status</th>
                  <th className="py-2 pr-3">Recent trades</th>
                  <th className="py-2 pr-3">Recent WR</th>
                  <th className="py-2 pr-3">Baseline WR</th>
                  <th className="py-2 pr-3">Recent net $</th>
                  <th className="py-2 pr-3">Reason</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.algorithm_id} className="border-b last:border-0 tabular-nums">
                    <td className="py-2 pr-3 font-medium align-top">{r.algorithm_name}</td>
                    <td className="py-2 pr-3 align-top">
                      <SeverityBadge severity={r.severity} />
                    </td>
                    <td className="py-2 pr-3 align-top text-muted-foreground">{r.algo_status}</td>
                    <td className="py-2 pr-3 align-top">{r.recent_trades}</td>
                    <td className="py-2 pr-3 align-top">
                      {r.baseline_win_rate == null ? "—" : `${r.recent_win_rate.toFixed(0)}%`}
                    </td>
                    <td className="py-2 pr-3 align-top">
                      {r.baseline_win_rate == null ? "—" : `${r.baseline_win_rate.toFixed(0)}%`}
                    </td>
                    <td
                      className={`py-2 pr-3 align-top ${r.recent_net_pnl < 0 ? "text-loss" : ""}`}
                    >
                      {r.recent_trades === 0 ? "—" : `$${r.recent_net_pnl.toFixed(0)}`}
                    </td>
                    <td className="py-2 pr-3 align-top text-muted-foreground">{r.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function RecentEventsCard({
  events,
  history_days,
}: {
  events: DriftEvent[];
  history_days: number;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">
          Recent drift events
          <span className="ml-2 text-xs font-normal text-muted-foreground">
            (last {history_days}d, max {events.length === 0 ? "—" : events.length})
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {events.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No drift events recorded in the last {history_days}d. Expected while algos are paused
            (drift detector arms only on the post-close scan after ≥ <code>min_trades</code> live
            closes, default 10).
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="py-2 pr-3">When</th>
                  <th className="py-2 pr-3">Algorithm</th>
                  <th className="py-2 pr-3">Severity</th>
                  <th className="py-2 pr-3">Recent trades</th>
                  <th className="py-2 pr-3">Recent WR</th>
                  <th className="py-2 pr-3">Reason</th>
                </tr>
              </thead>
              <tbody>
                {events.map((e) => (
                  <tr key={`${e.when}-${e.algorithm_id}`} className="border-b last:border-0 tabular-nums">
                    <td className="py-2 pr-3 align-top text-xs">{e.when.slice(0, 16).replace("T", " ")}Z</td>
                    <td className="py-2 pr-3 align-top font-medium">{e.algorithm_name}</td>
                    <td className="py-2 pr-3 align-top">
                      <SeverityBadge severity={e.severity} />
                    </td>
                    <td className="py-2 pr-3 align-top">{e.recent_trades ?? "—"}</td>
                    <td className="py-2 pr-3 align-top">
                      {e.recent_win_rate == null ? "—" : `${e.recent_win_rate.toFixed(0)}%`}
                    </td>
                    <td className="py-2 pr-3 align-top text-muted-foreground">{e.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
