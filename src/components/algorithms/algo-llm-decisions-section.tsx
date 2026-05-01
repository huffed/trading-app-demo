"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useLlmDecisions, type LlmDecisionRow } from "@/hooks/use-llm-decisions";
import { formatRelativeTime } from "@/lib/utils/pnl";
import { AlgoSection } from "./algo-section";

const DECISION_VARIANT: Record<
  LlmDecisionRow["decision"],
  "default" | "secondary" | "destructive" | "outline"
> = {
  enter_long: "default",
  enter_short: "destructive",
  hold: "outline",
  exit: "secondary",
};

const REGIME_LABEL: Record<LlmDecisionRow["regime"], string> = {
  HH: "HH",
  LH: "LH",
  RANGING: "RANGING",
  "n/a": "n/a",
};

function OutcomeBadge({ outcome }: { outcome: LlmDecisionRow["trade_outcome"] }) {
  if (!outcome || outcome.r_multiple == null) return null;
  const r = outcome.r_multiple;
  const colour =
    r > 0
      ? "text-[color:var(--profit)]"
      : r < 0
        ? "text-[color:var(--loss)]"
        : "text-muted-foreground";
  return (
    <span className={`text-xs font-medium ${colour}`}>
      {r >= 0 ? "+" : ""}
      {r.toFixed(2)}R
    </span>
  );
}

function DecisionRow({ entry }: { entry: LlmDecisionRow }) {
  const [expanded, setExpanded] = useState(false);
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
            <Badge variant={DECISION_VARIANT[entry.decision]} className="text-xs">
              {entry.decision}
            </Badge>
            <Badge variant="outline" className="text-xs">
              {REGIME_LABEL[entry.regime]}
            </Badge>
            {entry.confidence != null && (
              <span className="text-xs text-muted-foreground">
                conf {entry.confidence}
              </span>
            )}
            <OutcomeBadge outcome={entry.trade_outcome} />
            {entry.source !== "live" && (
              <Badge variant="secondary" className="text-xs">
                {entry.source}
              </Badge>
            )}
          </div>
          {entry.reasoning && (
            <p className="text-xs text-muted-foreground line-clamp-2">
              {entry.reasoning}
            </p>
          )}
        </div>
        <span className="text-xs text-muted-foreground shrink-0 ml-2">
          {formatRelativeTime(entry.bar_date)}
        </span>
      </button>
      {expanded && (
        <div className="ml-5 mt-2 space-y-2 text-xs">
          <DetailRow label="bar_date">{entry.bar_date}</DetailRow>
          <DetailRow label="prompt_version">{entry.prompt_version}</DetailRow>
          <DetailRow label="model">
            {entry.provider} / {entry.model}
          </DetailRow>
          <DetailRow label="had_position">{entry.had_position}</DetailRow>
          {entry.paper_position_id && (
            <DetailRow label="paper_position">
              <code className="text-[10px]">{entry.paper_position_id.slice(0, 8)}</code>
            </DetailRow>
          )}
          {entry.reasoning && (
            <div>
              <div className="text-muted-foreground mb-1">reasoning</div>
              <div className="rounded bg-muted/40 p-2 whitespace-pre-wrap">
                {entry.reasoning}
              </div>
            </div>
          )}
          {entry.context?.user_message != null && (
            <div>
              <div className="text-muted-foreground mb-1">user_message (LLM input)</div>
              <pre className="rounded bg-muted/40 p-2 whitespace-pre-wrap font-mono text-[11px] overflow-x-auto">
                {String(entry.context.user_message)}
              </pre>
            </div>
          )}
          {entry.trade_outcome && (
            <div>
              <div className="text-muted-foreground mb-1">trade_outcome</div>
              <pre className="rounded bg-muted/40 p-2 whitespace-pre-wrap font-mono text-[11px]">
                {JSON.stringify(entry.trade_outcome, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2">
      <span className="text-muted-foreground w-32 shrink-0">{label}</span>
      <span>{children}</span>
    </div>
  );
}

/**
 * Per-bar LLM decision audit. Each row is one LLM call: regime, decision,
 * confidence, reasoning. Click-through expands the full context the LLM
 * saw + trade outcome (if the decision opened a position that has since
 * closed). Foundation for operator retracing and the eventual Layer 3
 * in-context reflection feed.
 *
 * Renders only when the algorithm has rules.llm_trader.enabled — non-LLM
 * algos won't have decision rows.
 */
export function AlgoLlmDecisionsSection({ algorithmId }: { algorithmId: string }) {
  const { data, isLoading } = useLlmDecisions(algorithmId, 1, 25);
  const entries = data?.entries ?? [];

  return (
    <AlgoSection
      storageKey={`algo:${algorithmId}:section:llm-decisions`}
      title={`LLM decisions${data?.total ? ` (${data.total})` : ""}`}
    >
      {isLoading ? (
        <Skeleton className="h-32 w-full" />
      ) : entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No LLM decisions yet. Decisions appear here after each 4h bar-close
          scan tick. For backtest decisions, run the WF orchestrator with
          PERSIST_DECISIONS_TO_DB=1.
        </p>
      ) : (
        <div className="space-y-0">
          {entries.map((entry) => (
            <DecisionRow key={entry.id} entry={entry} />
          ))}
        </div>
      )}
    </AlgoSection>
  );
}
