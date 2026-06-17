"use client";

import { X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { SENTIMENT_OP_LABELS, TECHNICAL_OP_LABELS } from "@/lib/constants/algorithm";
import {
  isPatternCondition,
  isTechnicalCondition,
  type EntryCondition,
  type ExitCondition,
  type SentimentCondition,
} from "@/types/algorithm";

/** Read-only row representation of a single condition (technical /
 *  pattern / sentiment). Used by the rules editor + anywhere we display
 *  an algo's condition list. Hover reveals a remove button when
 *  onRemove is provided. */
export function ConditionRow({
  condition,
  onRemove,
}: {
  condition: EntryCondition | ExitCondition;
  onRemove?: () => void;
}) {
  if (isTechnicalCondition(condition)) {
    return (
      <Row onRemove={onRemove}>
        <Badge variant="outline" className="text-xs">
          {condition.indicator}
        </Badge>
        <span className="text-muted-foreground">
          {TECHNICAL_OP_LABELS[condition.operator] ?? condition.operator}
        </span>
        <span className="font-medium">{condition.value}</span>
        <span className="text-xs text-muted-foreground">({condition.timeframe})</span>
      </Row>
    );
  }
  if (isPatternCondition(condition)) {
    return (
      <Row onRemove={onRemove}>
        <Badge className="text-xs bg-amber-500/10 text-amber-600">pattern</Badge>
        <span className="text-muted-foreground">
          {condition.pattern}
          {condition.direction ? ` (${condition.direction})` : ""}
        </span>
        <span className="text-xs text-muted-foreground">({condition.timeframe})</span>
      </Row>
    );
  }
  const sentiment = condition as SentimentCondition;
  return (
    <Row onRemove={onRemove}>
      <Badge className="text-xs bg-primary/10 text-primary">sentiment</Badge>
      <span className="text-muted-foreground">
        {sentiment.metric} {SENTIMENT_OP_LABELS[sentiment.operator] ?? sentiment.operator}{" "}
        {sentiment.threshold}
      </span>
      {sentiment.topics?.map((t) => (
        <Badge key={t} variant="outline" className="text-xs">
          {t}
        </Badge>
      ))}
    </Row>
  );
}

function Row({ children, onRemove }: { children: React.ReactNode; onRemove?: () => void }) {
  return (
    <div className="flex items-center gap-1.5 text-sm group">
      {children}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          className="ml-auto opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
