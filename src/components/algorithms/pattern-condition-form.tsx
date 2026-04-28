"use client";

import { useState } from "react";
import { Plus, Sparkles } from "lucide-react";
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
import { PATTERN_DIRECTION_LABELS, PATTERN_LABELS } from "@/lib/constants/algorithm";
import type { PatternCondition } from "@/types/algorithm";

const PATTERN_OPTIONS = Object.keys(PATTERN_LABELS) as PatternCondition["pattern"][];
const TIMEFRAME_OPTIONS = ["15m", "1h", "4h", "1d"];
const DIRECTION_OPTIONS: ("any" | "bullish" | "bearish")[] = ["any", "bullish", "bearish"];

interface PatternDraft {
  pattern: PatternCondition["pattern"];
  direction: "any" | "bullish" | "bearish";
  timeframe: string;
  lookback: number;
  ma_period: number;
}

const EMPTY: PatternDraft = {
  pattern: "liquidity_sweep",
  direction: "any",
  timeframe: "1h",
  lookback: 5,
  ma_period: 20,
};

function draftToCondition(d: PatternDraft): PatternCondition {
  // daily_bias is the only pattern that uses ma_period; everything else
  // uses lookback. Keep the persisted blob lean by omitting fields the
  // pattern doesn't consume so the activity log + audit diff stay
  // readable.
  if (d.pattern === "daily_bias") {
    return {
      type: "pattern",
      pattern: d.pattern,
      direction: d.direction === "any" ? undefined : d.direction,
      ma_period: d.ma_period,
      timeframe: d.timeframe,
    };
  }
  return {
    type: "pattern",
    pattern: d.pattern,
    direction: d.direction === "any" ? undefined : d.direction,
    lookback: d.lookback,
    timeframe: d.timeframe,
  };
}

function PatternSelect({
  value,
  onChange,
}: {
  value: PatternCondition["pattern"];
  onChange: (v: PatternCondition["pattern"]) => void;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-xs">Pattern</Label>
      <Select value={value} onValueChange={(v) => v && onChange(v as PatternCondition["pattern"])}>
        <SelectTrigger className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {PATTERN_OPTIONS.map((p) => (
            <SelectItem key={p} value={p}>
              {PATTERN_LABELS[p]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function DirectionSelect({
  value,
  onChange,
}: {
  value: "any" | "bullish" | "bearish";
  onChange: (v: "any" | "bullish" | "bearish") => void;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-xs">Direction filter</Label>
      <Select value={value} onValueChange={(v) => v && onChange(v as typeof value)}>
        <SelectTrigger className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {DIRECTION_OPTIONS.map((d) => (
            <SelectItem key={d} value={d}>
              {PATTERN_DIRECTION_LABELS[d]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function TimeframeSelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-xs">Timeframe</Label>
      <Select value={value} onValueChange={(v) => v && onChange(v)}>
        <SelectTrigger className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {TIMEFRAME_OPTIONS.map((t) => (
            <SelectItem key={t} value={t}>
              {t}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

interface PatternConditionFormProps {
  onAdd: (condition: PatternCondition) => void;
}

/**
 * Compact inline form for adding ICT/SMC pattern conditions to an
 * algorithm's entry or exit list. Replaces the "edit chat marker JSON
 * by hand" path that's currently the only way to add patterns. The
 * form mirrors the Zod patternConditionSchema so what lands in the DB
 * is already shaped correctly.
 */
export function PatternConditionForm({ onAdd }: PatternConditionFormProps) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<PatternDraft>(EMPTY);

  if (!open) {
    return (
      <Button
        size="xs"
        variant="outline"
        onClick={() => setOpen(true)}
        className="text-xs"
      >
        <Sparkles className="mr-1 h-3 w-3" />
        Add pattern condition
      </Button>
    );
  }

  const showLookback = draft.pattern !== "daily_bias";
  const showMaPeriod = draft.pattern === "daily_bias";

  return (
    <div className="space-y-3 rounded-md border p-3">
      <div className="grid gap-2 sm:grid-cols-3">
        <PatternSelect
          value={draft.pattern}
          onChange={(v) => setDraft((d) => ({ ...d, pattern: v }))}
        />
        <DirectionSelect
          value={draft.direction}
          onChange={(v) => setDraft((d) => ({ ...d, direction: v }))}
        />
        <TimeframeSelect
          value={draft.timeframe}
          onChange={(v) => setDraft((d) => ({ ...d, timeframe: v }))}
        />
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {showLookback && (
          <div className="space-y-1">
            <Label className="text-xs">Lookback bars</Label>
            <Input
              type="number"
              min={1}
              max={100}
              value={draft.lookback}
              onChange={(e) =>
                setDraft((d) => ({ ...d, lookback: Math.max(1, Number(e.target.value) || 5) }))
              }
            />
          </div>
        )}
        {showMaPeriod && (
          <div className="space-y-1">
            <Label className="text-xs">MA period</Label>
            <Input
              type="number"
              min={1}
              max={500}
              value={draft.ma_period}
              onChange={(e) =>
                setDraft((d) => ({ ...d, ma_period: Math.max(1, Number(e.target.value) || 20) }))
              }
            />
          </div>
        )}
      </div>
      <div className="flex justify-end gap-2">
        <Button
          size="xs"
          variant="ghost"
          onClick={() => {
            setOpen(false);
            setDraft(EMPTY);
          }}
        >
          Cancel
        </Button>
        <Button
          size="xs"
          onClick={() => {
            onAdd(draftToCondition(draft));
            setOpen(false);
            setDraft(EMPTY);
          }}
        >
          <Plus className="mr-1 h-3 w-3" />
          Add
        </Button>
      </div>
    </div>
  );
}
