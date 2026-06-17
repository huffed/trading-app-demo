"use client";

import { useState } from "react";
import { Newspaper, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SENTIMENT_OP_LABELS } from "@/lib/constants/algorithm";
import type { SentimentCondition, SentimentOperator } from "@/types/algorithm";

const SOURCE_OPTIONS: ("news" | "social")[] = ["news", "social"];

/** Common Alpha Vantage NEWS_SENTIMENT metrics. Custom strings are
 *  allowed in the DB schema but this picker covers the well-tested set. */
const METRIC_OPTIONS: { value: string; label: string }[] = [
  { value: "overall_sentiment", label: "Overall sentiment (-1 to +1)" },
  { value: "article_count", label: "Article count" },
  { value: "topic_buzz", label: "Topic buzz" },
];

const OPERATOR_OPTIONS: SentimentOperator[] = ["above", "below", "spike_above", "spike_below"];

const TIMEFRAME_OPTIONS = ["1h", "4h", "1d"];

interface SentimentDraft {
  source: "news" | "social";
  metric: string;
  operator: SentimentOperator;
  threshold: number;
  topicsCsv: string;
  tickersCsv: string;
  timeframe: string;
}

const EMPTY: SentimentDraft = {
  source: "news",
  metric: "overall_sentiment",
  operator: "above",
  threshold: 0.15,
  topicsCsv: "",
  tickersCsv: "",
  timeframe: "1d",
};

function csvToArray(csv: string): string[] | undefined {
  const trimmed = csv.trim();
  if (!trimmed) return undefined;
  return trimmed
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function SelectField<T extends string>({
  label,
  value,
  options,
  onChange,
  className,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  className?: string;
}) {
  return (
    <div className={`space-y-1 ${className ?? ""}`}>
      <Label className="text-xs">{label}</Label>
      <Select value={value} onValueChange={(v) => v && onChange(v as T)}>
        <SelectTrigger className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function SentimentFormFields({
  draft,
  setDraft,
}: {
  draft: SentimentDraft;
  setDraft: (next: SentimentDraft | ((d: SentimentDraft) => SentimentDraft)) => void;
}) {
  return (
    <>
      <div className="grid gap-2 sm:grid-cols-4">
        <SelectField
          label="Source"
          value={draft.source}
          options={SOURCE_OPTIONS.map((s) => ({ value: s, label: s }))}
          onChange={(v) => setDraft((d) => ({ ...d, source: v }))}
        />
        <SelectField
          label="Metric"
          value={draft.metric}
          options={METRIC_OPTIONS}
          onChange={(v) => setDraft((d) => ({ ...d, metric: v }))}
          className="sm:col-span-2"
        />
        <SelectField
          label="Timeframe"
          value={draft.timeframe}
          options={TIMEFRAME_OPTIONS.map((t) => ({ value: t, label: t }))}
          onChange={(v) => setDraft((d) => ({ ...d, timeframe: v }))}
        />
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <SelectField
          label="Operator"
          value={draft.operator}
          options={OPERATOR_OPTIONS.map((op) => ({ value: op, label: SENTIMENT_OP_LABELS[op] }))}
          onChange={(v) => setDraft((d) => ({ ...d, operator: v }))}
        />
        <div className="space-y-1">
          <Label className="text-xs">Threshold</Label>
          <Input
            type="number"
            step="any"
            value={draft.threshold}
            onChange={(e) => setDraft((d) => ({ ...d, threshold: Number(e.target.value) }))}
          />
        </div>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="space-y-1">
          <Label className="text-xs">Topics (comma-separated, optional)</Label>
          <Input
            placeholder="earnings, fed_policy"
            value={draft.topicsCsv}
            onChange={(e) => setDraft((d) => ({ ...d, topicsCsv: e.target.value }))}
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Tickers (comma-separated, optional)</Label>
          <Input
            placeholder="AAPL, MSFT"
            value={draft.tickersCsv}
            onChange={(e) => setDraft((d) => ({ ...d, tickersCsv: e.target.value }))}
          />
        </div>
      </div>
    </>
  );
}

function draftToCondition(draft: SentimentDraft): SentimentCondition {
  const condition: SentimentCondition = {
    type: "sentiment",
    source: draft.source,
    metric: draft.metric,
    operator: draft.operator,
    threshold: draft.threshold,
    timeframe: draft.timeframe,
  };
  const topics = csvToArray(draft.topicsCsv);
  if (topics) condition.topics = topics;
  const tickers = csvToArray(draft.tickersCsv);
  if (tickers) condition.tickers = tickers;
  return condition;
}

/** Compact inline form for adding sentiment conditions (news / social
 *  signals from Alpha Vantage NEWS_SENTIMENT API). Sentiment conditions
 *  are filtered out at backtest time (no historical sentiment corpus) —
 *  they only fire in live signal evaluation, surfaced as a "Live Signal
 *  Check" card on the algorithm detail page. See CLAUDE.md. */
export function SentimentConditionForm({
  onAdd,
}: {
  onAdd: (condition: SentimentCondition) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<SentimentDraft>(EMPTY);

  if (!open) {
    return (
      <Button size="xs" variant="outline" onClick={() => setOpen(true)} className="text-xs">
        <Newspaper className="mr-1 h-3 w-3" />
        Add sentiment condition
      </Button>
    );
  }

  function close() {
    setOpen(false);
    setDraft(EMPTY);
  }

  return (
    <div className="space-y-3 rounded-md border p-3">
      <SentimentFormFields draft={draft} setDraft={setDraft} />
      <div className="flex justify-end gap-2">
        <Button size="xs" variant="ghost" onClick={close}>
          Cancel
        </Button>
        <Button
          size="xs"
          onClick={() => {
            onAdd(draftToCondition(draft));
            close();
          }}
        >
          <Plus className="mr-1 h-3 w-3" />
          Add
        </Button>
      </div>
    </div>
  );
}
