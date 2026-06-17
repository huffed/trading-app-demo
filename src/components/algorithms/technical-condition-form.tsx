"use client";

import { useState } from "react";
import { Activity, Plus } from "lucide-react";
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
import { TECHNICAL_OP_LABELS } from "@/lib/constants/algorithm";
import type { IndicatorOperator, TechnicalCondition } from "@/types/algorithm";

/** Indicators known to the backtest engine (see lib/market-data/indicator-registry.ts).
 *  Display order groups price-MA indicators (left) and oscillators (right). */
const INDICATORS: { value: string; label: string }[] = [
  { value: "RSI", label: "RSI (14)" },
  { value: "SMA20", label: "SMA (20)" },
  { value: "SMA50", label: "SMA (50)" },
  { value: "SMA200", label: "SMA (200)" },
  { value: "EMA12", label: "EMA (12)" },
  { value: "EMA26", label: "EMA (26)" },
  { value: "MACD", label: "MACD" },
  { value: "BollingerBands_upper", label: "Bollinger upper" },
  { value: "BollingerBands_lower", label: "Bollinger lower" },
];

const OPERATOR_OPTIONS: IndicatorOperator[] = [
  "less_than",
  "greater_than",
  "crosses_above",
  "crosses_below",
];

const TIMEFRAME_OPTIONS = ["15m", "30m", "1h", "4h", "1d"];

const PRICE_MA_INDICATORS = new Set([
  "SMA20",
  "SMA50",
  "SMA200",
  "EMA12",
  "EMA26",
  "BollingerBands_upper",
  "BollingerBands_lower",
]);

interface TechnicalDraft {
  indicator: string;
  operator: IndicatorOperator;
  value: number;
  timeframe: string;
}

const EMPTY: TechnicalDraft = {
  indicator: "RSI",
  operator: "less_than",
  value: 30,
  timeframe: "1h",
};

function PickSelect<T extends string>({
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

function TechnicalFormFields({
  draft,
  setDraft,
}: {
  draft: TechnicalDraft;
  setDraft: (next: TechnicalDraft | ((d: TechnicalDraft) => TechnicalDraft)) => void;
}) {
  const isPriceMA = PRICE_MA_INDICATORS.has(draft.indicator);
  const valueHint = (() => {
    if (draft.value === 0 && isPriceMA) {
      return "value=0 → compare against price";
    }
    if (draft.value === 0 && draft.indicator === "EMA12") {
      return "value=0 → MACD crossover (EMA12 vs EMA26)";
    }
    if (draft.indicator === "RSI") {
      return "RSI scale 0–100 (30/70 = standard oversold/overbought)";
    }
    return undefined;
  })();

  return (
    <>
      <div className="grid gap-2 sm:grid-cols-4">
        <PickSelect
          label="Indicator"
          value={draft.indicator}
          options={INDICATORS}
          onChange={(v) => setDraft((d) => ({ ...d, indicator: v }))}
          className="sm:col-span-2"
        />
        <PickSelect
          label="Operator"
          value={draft.operator}
          options={OPERATOR_OPTIONS.map((op) => ({ value: op, label: TECHNICAL_OP_LABELS[op] }))}
          onChange={(v) => setDraft((d) => ({ ...d, operator: v }))}
        />
        <PickSelect
          label="Timeframe"
          value={draft.timeframe}
          options={TIMEFRAME_OPTIONS.map((t) => ({ value: t, label: t }))}
          onChange={(v) => setDraft((d) => ({ ...d, timeframe: v }))}
        />
      </div>
      <div className="space-y-1">
        <Label className="text-xs">Value</Label>
        <Input
          type="number"
          step="any"
          value={draft.value}
          onChange={(e) => setDraft((d) => ({ ...d, value: Number(e.target.value) }))}
        />
        {valueHint && <p className="text-[10px] text-muted-foreground">{valueHint}</p>}
      </div>
    </>
  );
}

/** Inline compact form for adding technical conditions (RSI, SMA, EMA,
 *  MACD, Bollinger Bands) to an algorithm's entry/exit list. Mirrors the
 *  PatternConditionForm pattern. Value=0 has special semantics on price
 *  MA indicators: the backtest engine compares indicator vs price (e.g.
 *  "SMA20 crosses_above 0" = "price crosses above SMA20"). EMA12 vs 0 is
 *  the standard MACD crossover (EMA12 vs EMA26). See CLAUDE.md
 *  "Condition value=0 Semantics".
 */
export function TechnicalConditionForm({
  onAdd,
}: {
  onAdd: (condition: TechnicalCondition) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<TechnicalDraft>(EMPTY);

  if (!open) {
    return (
      <Button size="xs" variant="outline" onClick={() => setOpen(true)} className="text-xs">
        <Activity className="mr-1 h-3 w-3" />
        Add technical condition
      </Button>
    );
  }

  function close() {
    setOpen(false);
    setDraft(EMPTY);
  }

  function submit() {
    onAdd({
      type: "technical",
      indicator: draft.indicator,
      operator: draft.operator,
      value: draft.value,
      timeframe: draft.timeframe,
    });
    close();
  }

  return (
    <div className="space-y-3 rounded-md border p-3">
      <TechnicalFormFields draft={draft} setDraft={setDraft} />
      <div className="flex justify-end gap-2">
        <Button size="xs" variant="ghost" onClick={close}>
          Cancel
        </Button>
        <Button size="xs" onClick={submit}>
          <Plus className="mr-1 h-3 w-3" />
          Add
        </Button>
      </div>
    </div>
  );
}
