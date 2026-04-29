"use client";

import { Check, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { usePositionEntryContext } from "@/hooks/use-position-stats";
import {
  PATTERN_LABELS,
  TECHNICAL_OP_LABELS,
} from "@/lib/constants/algorithm";
import {
  isPatternCondition,
  isSentimentCondition,
  isTechnicalCondition,
  type EntryCondition,
} from "@/types/algorithm";
import type { PaperPosition } from "@/types/position";

function ConditionRow({
  index,
  cond,
  fired,
}: {
  index: number;
  cond: EntryCondition;
  /** Null when the engine didn't emit a per-condition breakdown for
   *  this entry — older positions or sentiment-only setups. */
  fired: boolean | null;
}) {
  const tf = "timeframe" in cond ? cond.timeframe : null;
  let body: React.ReactNode;
  if (isPatternCondition(cond)) {
    const pattern = PATTERN_LABELS[cond.pattern] ?? cond.pattern;
    const dir = cond.direction ? ` · ${cond.direction}` : "";
    const lookback = cond.lookback != null ? ` · lookback ${cond.lookback}` : "";
    body = (
      <span>
        <span className="font-medium">{pattern}</span>
        <span className="text-muted-foreground">
          {dir}
          {lookback}
        </span>
      </span>
    );
  } else if (isTechnicalCondition(cond)) {
    const op = TECHNICAL_OP_LABELS[cond.operator] ?? cond.operator;
    body = (
      <span>
        <span className="font-medium">{cond.indicator}</span>
        <span className="text-muted-foreground">
          {" "}
          {op} {cond.value}
        </span>
      </span>
    );
  } else if (isSentimentCondition(cond)) {
    body = (
      <span>
        <span className="font-medium">Sentiment</span>
        <span className="text-muted-foreground">
          {" · "}
          {cond.source}/{cond.metric}
        </span>
      </span>
    );
  } else {
    body = <span className="text-muted-foreground">Unknown condition</span>;
  }
  return (
    <li className="flex items-center gap-2 py-1.5 px-3">
      <span className="w-5 text-xs text-muted-foreground tabular-nums">{index + 1}.</span>
      {fired === true && (
        <Check className="h-3.5 w-3.5 shrink-0 text-[var(--profit)]" aria-label="fired" />
      )}
      {fired === false && (
        <X className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-label="did not fire" />
      )}
      {fired === null && <span className="h-3.5 w-3.5 shrink-0" />}
      <div className="flex-1 text-sm">{body}</div>
      {tf && (
        <Badge variant="outline" className="text-[10px] tabular-nums">
          {tf}
        </Badge>
      )}
    </li>
  );
}

function logicLabel(logic: ReturnType<typeof Object> | undefined): string {
  if (!logic) return "all";
  if (logic === "all") return "all";
  if (logic === "any") return "any";
  if (typeof logic === "object" && "type" in logic && logic.type === "n_of_m") {
    return `${logic.n}-of-M (n_of_m)`;
  }
  return "all";
}

export function PositionConditionsPanel({ pos }: { pos: PaperPosition }) {
  const { data: ctx, isLoading } = usePositionEntryContext(pos.id, true);

  if (isLoading && !ctx) {
    return (
      <div className="px-4 py-3 space-y-2">
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }
  if (!ctx) {
    return (
      <p className="px-4 py-3 text-sm text-muted-foreground">
        Algorithm rules not available for this position.
      </p>
    );
  }

  const met = ctx.conditions_met;
  const total = ctx.conditions_total ?? ctx.conditions.length;
  const allFired = met != null && total != null && met >= total;

  return (
    <div className="px-4 py-3 space-y-3">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span>
          Logic: <span className="font-medium">{logicLabel(ctx.logic)}</span>
        </span>
        <span>·</span>
        <span>
          Primary timeframe: <span className="font-medium">{ctx.primary_timeframe}</span>
        </span>
        {met != null && total != null && (
          <Badge
            variant={allFired ? "default" : "secondary"}
            className="ml-auto text-[10px]"
          >
            {met} of {total} fired at entry
          </Badge>
        )}
      </div>
      <ul className="divide-y rounded-md border bg-background">
        {ctx.conditions.map((cond, i) => (
          <ConditionRow
            key={i}
            index={i}
            cond={cond}
            fired={ctx.conditions_breakdown ? ctx.conditions_breakdown[i] ?? null : null}
          />
        ))}
      </ul>
      {ctx.conditions_breakdown == null && met == null && (
        <p className="text-[10px] text-muted-foreground italic">
          Entry signal not located for this position — likely opened before the engine started
          logging detailed signal_detected events.
        </p>
      )}
      {ctx.conditions_breakdown == null && met != null && (
        <p className="text-[10px] text-muted-foreground italic">
          Per-condition breakdown wasn&apos;t logged for this entry. New positions will record
          ✓/✗ per condition.
        </p>
      )}
    </div>
  );
}
