"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useEvaluationLog, type EvaluationLogRow } from "@/hooks/use-evaluation-log";
import { formatRelativeTime } from "@/lib/utils/pnl";
import { AlgoSection } from "./algo-section";

type BadgeVariant = "default" | "secondary" | "destructive" | "outline";

const EVENT_BADGE: Record<string, { label: string; variant: BadgeVariant }> = {
  signal_no_action: { label: "no action", variant: "outline" },
  signal_detected: { label: "signal", variant: "default" },
  position_opened: { label: "opened", variant: "default" },
  position_closed: { label: "closed", variant: "secondary" },
  stop_loss_hit: { label: "SL hit", variant: "destructive" },
  take_profit_hit: { label: "TP hit", variant: "default" },
  live_order_placed: { label: "broker order", variant: "default" },
  live_order_failed: { label: "broker FAIL", variant: "destructive" },
  live_order_closed: { label: "broker close", variant: "secondary" },
  live_close_failed: { label: "broker close FAIL", variant: "destructive" },
  daily_loss_halt: { label: "daily halt", variant: "destructive" },
  divergence_halt: { label: "divergence halt", variant: "destructive" },
  drift_halt: { label: "drift halt", variant: "destructive" },
  portfolio_halt: { label: "portfolio halt", variant: "destructive" },
  pair_auto_paused: { label: "pair paused", variant: "destructive" },
  broker_reconciliation_drift: { label: "reconcile drift", variant: "destructive" },
  error: { label: "error", variant: "destructive" },
};

function headline(row: EvaluationLogRow): string {
  const d = row.details ?? {};
  const reason = typeof d.reason === "string" ? d.reason : null;
  const verdict = typeof d.verdict === "string" ? d.verdict : null;
  if (reason === "market_state_gate" && verdict) return `state gate: ${verdict}`;
  if (reason) return reason;
  if (verdict) return verdict;
  return EVENT_BADGE[row.event_type]?.label ?? row.event_type;
}

function marketStateChip(row: EvaluationLogRow): string | null {
  const ms = row.details?.market_state;
  if (!ms || typeof ms !== "object") return null;
  const s = ms as Record<string, unknown>;
  const parts = (["mtf", "vol", "range", "dxy"] as const)
    .filter((k) => typeof s[k] === "string" && s[k] !== "n/a")
    .map((k) => `${k}=${String(s[k])}`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

function EvaluationRow({ row }: { row: EvaluationLogRow }) {
  const [expanded, setExpanded] = useState(false);
  const badge = EVENT_BADGE[row.event_type] ?? {
    label: row.event_type,
    variant: "outline" as BadgeVariant,
  };
  const stateChip = marketStateChip(row);
  return (
    <div className="border-b border-border last:border-0 py-2">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-start gap-2 text-left text-sm hover:bg-muted/30 -mx-2 px-2 rounded"
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 mt-0.5 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 mt-0.5 text-muted-foreground" />
        )}
        <div className="flex-1 min-w-0 space-y-1">
          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant={badge.variant} className="text-xs">
              {badge.label}
            </Badge>
            {row.ticker && (
              <span className="text-xs text-muted-foreground">{row.ticker}</span>
            )}
            {stateChip && (
              <Badge variant="outline" className="text-[10px] font-normal tabular-nums">
                {stateChip}
              </Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground line-clamp-2">{headline(row)}</p>
        </div>
        <span className="text-xs text-muted-foreground shrink-0 ml-2">
          {formatRelativeTime(row.created_at)}
        </span>
      </button>
      {expanded && row.details && (
        <div className="ml-5 mt-2 text-xs">
          <pre className="rounded bg-muted/40 p-2 whitespace-pre-wrap font-mono text-[11px] overflow-x-auto">
            {JSON.stringify(row.details, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

/**
 * Engine-side evaluation trail — the deterministic counterpart of the
 * LLM decisions feed. Every gate verdict (incl. market_state_gate with
 * its state snapshot), condition miss, entry, exit, broker-mirror event
 * and halt for this algorithm, newest first. For library algos this IS
 * the decision display; for LLM algos it complements the decisions
 * section with what the engine did around each call.
 */
export function AlgoEvaluationLogSection({ algorithmId }: { algorithmId: string }) {
  const { data, isLoading } = useEvaluationLog(algorithmId, 30);
  const entries = data?.entries ?? [];

  return (
    <AlgoSection
      storageKey={`algo:${algorithmId}:section:evaluation-log`}
      title="Engine evaluations"
    >
      {isLoading ? (
        <Skeleton className="h-32 w-full" />
      ) : entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No evaluations yet. Rows appear after each scan tick that reaches
          this algorithm — gate verdicts, condition checks, entries, exits
          and halts.
        </p>
      ) : (
        <div className="space-y-0">
          {entries.map((row) => (
            <EvaluationRow key={row.id} row={row} />
          ))}
        </div>
      )}
    </AlgoSection>
  );
}
