"use client";

import { useState } from "react";
import { AlertCircle, AlertTriangle, CheckCircle2, Loader2, ShieldCheck } from "lucide-react";
import { runAlgorithmReadinessCheck } from "@/app/(dashboard)/algorithms/readiness-actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Surface } from "@/components/ui/surface";
import type {
  ReadinessCheckResult,
  ReadinessReport,
  ReadinessSeverity,
} from "@/lib/scan/readiness-check";

const SEVERITY_LABELS: Record<ReadinessSeverity, string> = {
  pass: "Pass",
  caution: "Caution",
  fail: "Fail",
};

const CHECK_LABELS: Record<string, string> = {
  walk_forward_stability: "Walk-forward stability",
  pair_quality: "Pair quality",
  side_symmetry: "Side symmetry",
  ftmo_fit: "FTMO fit",
};

function VerdictBadge({ verdict }: { verdict: ReadinessSeverity }) {
  if (verdict === "pass") {
    return (
      <Badge className="bg-[var(--profit)]/15 text-[var(--profit)]">
        <CheckCircle2 className="mr-1 h-3 w-3" />
        {SEVERITY_LABELS.pass}
      </Badge>
    );
  }
  if (verdict === "caution") {
    return (
      <Badge className="bg-amber-500/15 text-amber-600">
        <AlertTriangle className="mr-1 h-3 w-3" />
        {SEVERITY_LABELS.caution}
      </Badge>
    );
  }
  return (
    <Badge className="bg-[var(--loss)]/15 text-[var(--loss)]">
      <AlertCircle className="mr-1 h-3 w-3" />
      {SEVERITY_LABELS.fail}
    </Badge>
  );
}

function CheckRow({ check }: { check: ReadinessCheckResult }) {
  const label = CHECK_LABELS[check.name] ?? check.name;
  return (
    <div className="space-y-0.5 rounded-md border p-2.5">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="font-medium">{label}</span>
        <VerdictBadge verdict={check.severity} />
      </div>
      <p className="text-xs text-muted-foreground leading-relaxed">{check.reason}</p>
    </div>
  );
}

function ResultBody({ report }: { report: ReadinessReport }) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          Walk-forward: {report.walk_forward_summary.windows} windows · mean WR{" "}
          {report.walk_forward_summary.mean_win_rate.toFixed(1)}%
        </p>
        <VerdictBadge verdict={report.verdict} />
      </div>
      <div className="space-y-2">
        {report.checks.map((c) => (
          <CheckRow key={c.name} check={c} />
        ))}
      </div>
    </div>
  );
}

function RunButtonLabel({
  isLoading,
  hasReport,
}: {
  isLoading: boolean;
  hasReport: boolean;
}) {
  if (isLoading) {
    return (
      <>
        <Loader2 className="mr-1 h-3 w-3 animate-spin" />
        Running...
      </>
    );
  }
  return <>{hasReport ? "Re-run" : "Run check"}</>;
}

export function ReadinessCheckCard({ algorithmId }: { algorithmId: string }) {
  const [report, setReport] = useState<ReadinessReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  async function handleRun() {
    setIsLoading(true);
    setError(null);
    setReport(null);
    try {
      const r = await runAlgorithmReadinessCheck(algorithmId);
      if (r.success) setReport(r.data);
      else setError(r.error);
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <Surface elevation="low" className="p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <ShieldCheck className="h-4 w-4 text-muted-foreground" />
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Readiness check</p>
        </div>
        <Button size="xs" onClick={handleRun} disabled={isLoading}>
          <RunButtonLabel isLoading={isLoading} hasReport={report !== null} />
        </Button>
      </div>
      {!report && !isLoading && !error && (
        <p className="text-xs text-muted-foreground">
          Aggregate verdict before flipping live trading. Walk-forward stability + pair quality +
          side symmetry + FTMO fit. Worst severity wins. Takes 5-30s depending on watchlist size.
        </p>
      )}
      {error && <p className="text-xs text-[var(--loss)]">{error}</p>}
      {report && <ResultBody report={report} />}
    </Surface>
  );
}
