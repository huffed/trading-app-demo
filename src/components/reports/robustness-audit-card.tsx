"use client";

import { Activity, AlertCircle, CheckCircle2, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useRobustnessAudits } from "@/hooks/use-robustness-audits";
import type { RobustnessAudit, RobustnessSubGate } from "@/lib/algo-search/robustness-audit-loader";

/**
 * F2 search-robustness audit card for the /reports Search tab.
 * Renders per-candidate aggregate verdicts + sub-gate breakdowns from
 * the JSON files in scripts/canonical/robustness-audit-*.json.
 *
 * Empty state: no audits loaded → renders an explanatory empty card,
 * not silence. Operator should see "no audits yet" rather than "broken".
 */
export function RobustnessAuditCard() {
  const { data, isLoading, isError, error } = useRobustnessAudits();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Activity className="h-4 w-4" />
          F2 search-robustness audits
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading && <Skeleton className="h-24 w-full" />}
        {isError && (
          <div className="flex items-start gap-2 text-sm">
            <AlertCircle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
            <div>
              <p className="font-medium">Failed to load robustness audits</p>
              <p className="text-muted-foreground">
                {error instanceof Error ? error.message : "Unknown error"}
              </p>
            </div>
          </div>
        )}
        {data && !isLoading && data.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No robustness audits yet. Operator runs F2 sub-gates via{" "}
            <code>pnpm dlx tsx scripts/canonical/robustness-{"{"}
            multi-cut,leave-n-out,bootstrap-bars,alt-objective{"}"}.ts</code> and aggregates with{" "}
            <code>scripts/canonical/robustness-aggregate.ts</code>. F2 PASS is the
            prerequisite for any G.6 deploy stamp.
          </p>
        )}
        {data && !isLoading && data.length > 0 && (
          <div className="space-y-3">
            {data.map((audit) => (
              <AuditRow key={audit.file} audit={audit} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function AuditRow({ audit }: { audit: RobustnessAudit }) {
  const verdictColor =
    audit.aggregate_verdict === "PASS" ? "default" : "destructive";
  return (
    <div className="rounded-md border border-glass-border p-3 space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium truncate">{audit.candidate_name}</p>
          <p className="text-xs text-muted-foreground font-mono mt-0.5">
            {audit.candidate_id}
          </p>
        </div>
        <Badge variant={verdictColor} className="shrink-0">
          {audit.aggregate_verdict}
        </Badge>
      </div>
      <div className="flex flex-wrap gap-2 text-xs">
        <span>
          PASS {audit.pass_count}/{audit.gate_threshold + (4 - audit.gate_threshold)}
        </span>
        <span className="text-muted-foreground">·</span>
        <span>FAIL {audit.fail_count}</span>
        <span className="text-muted-foreground">·</span>
        <span>{audit.audit_complete ? "complete" : `${audit.missing_count} missing`}</span>
        <span className="text-muted-foreground">·</span>
        <span className="font-mono text-muted-foreground">
          {new Date(audit.generated_at).toISOString().slice(0, 16).replace("T", " ")}
        </span>
      </div>
      <div className="grid gap-1 sm:grid-cols-2">
        {audit.sub_gates.map((sg) => (
          <SubGateRow key={sg.path} sg={sg} />
        ))}
      </div>
      {audit.next_action && (
        <p className="text-xs text-muted-foreground italic mt-1">
          Next: {audit.next_action}
        </p>
      )}
    </div>
  );
}

function colorFor(verdict: RobustnessSubGate["verdict"]): string {
  if (verdict === "PASS") return "text-[var(--profit)]";
  if (verdict === "FAIL") return "text-[var(--loss)]";
  return "text-muted-foreground";
}

function SubGateIcon({ verdict, className }: { verdict: RobustnessSubGate["verdict"]; className: string }) {
  if (verdict === "PASS") return <CheckCircle2 className={className} />;
  if (verdict === "FAIL") return <XCircle className={className} />;
  return <AlertCircle className={className} />;
}

function SubGateRow({ sg }: { sg: RobustnessSubGate }) {
  const color = colorFor(sg.verdict);
  return (
    <div className="flex items-center gap-1.5 text-xs">
      <SubGateIcon verdict={sg.verdict} className={`h-3.5 w-3.5 ${color} shrink-0`} />
      <span className="truncate">{sg.label}</span>
      <span className="ml-auto font-mono text-muted-foreground shrink-0">
        {sg.verdict}
      </span>
    </div>
  );
}
