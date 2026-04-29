"use client";

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
}: {
  index: number;
  cond: EntryCondition;
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
    <li className="flex items-baseline gap-2 py-1.5">
      <span className="w-5 text-xs text-muted-foreground tabular-nums">{index + 1}.</span>
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
          <ConditionRow key={i} index={i} cond={cond} />
        ))}
      </ul>
      {met == null && (
        <p className="text-[10px] text-muted-foreground italic">
          Per-condition fire/no-fire detail isn&apos;t logged yet — only the aggregate count.
          Engine update queued.
        </p>
      )}
    </div>
  );
}
