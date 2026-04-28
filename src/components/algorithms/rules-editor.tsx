"use client";

import { useState } from "react";
import { X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SENTIMENT_OP_LABELS, TECHNICAL_OP_LABELS } from "@/lib/constants/algorithm";
import {
  PROP_FIRM_LABELS,
  PROP_FIRM_PRESETS,
  type PropFirmPreset,
} from "@/lib/constants/prop-firm";
import {
  isPatternCondition,
  isTechnicalCondition,
  type AlgorithmRules,
  type EntryCondition,
  type ExitCondition,
  type PatternCondition,
  type PropFirmRules,
  type SentimentCondition,
} from "@/types/algorithm";
import { PatternConditionForm } from "./pattern-condition-form";
import { PropFirmFields } from "./prop-firm-fields";

function ConditionRow({
  condition,
  onRemove,
}: {
  condition: EntryCondition | ExitCondition;
  onRemove: () => void;
}) {
  if (isTechnicalCondition(condition)) {
    return (
      <div className="flex items-center gap-1.5 text-sm group">
        <Badge variant="outline" className="text-xs">
          {condition.indicator}
        </Badge>
        <span className="text-muted-foreground">
          {TECHNICAL_OP_LABELS[condition.operator] ?? condition.operator}
        </span>
        <span className="font-medium">{condition.value}</span>
        <span className="text-xs text-muted-foreground">({condition.timeframe})</span>
        <button
          type="button"
          onClick={onRemove}
          className="ml-auto opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  }
  if (isPatternCondition(condition)) {
    return (
      <div className="flex items-center gap-1.5 text-sm group">
        <Badge className="text-xs bg-amber-500/10 text-amber-600">pattern</Badge>
        <span className="text-muted-foreground">
          {condition.pattern}
          {condition.direction ? ` (${condition.direction})` : ""}
        </span>
        <span className="text-xs text-muted-foreground">({condition.timeframe})</span>
        <button
          type="button"
          onClick={onRemove}
          className="ml-auto opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  }
  const sentiment = condition as SentimentCondition;
  return (
    <div className="flex items-center gap-1.5 text-sm group">
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
      <button
        type="button"
        onClick={onRemove}
        className="ml-auto opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function NumericField({
  label,
  value,
  onChange,
  suffix,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  suffix?: string;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      <div className="flex items-center gap-1.5">
        <Input
          type="number"
          min={0}
          value={value}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (!isNaN(n)) {
              onChange(n);
            }
          }}
          className="w-24"
        />
        {suffix && <span className="text-xs text-muted-foreground">{suffix}</span>}
      </div>
    </div>
  );
}

function PropFirmSection({
  propFirm,
  onChange,
}: {
  propFirm?: PropFirmRules;
  onChange: (pf: PropFirmRules | undefined) => void;
}) {
  const [preset, setPreset] = useState<PropFirmPreset>(propFirm ? "custom" : "custom");

  function handlePreset(key: PropFirmPreset) {
    setPreset(key);
    if (key === "custom") {
      onChange(undefined);
      return;
    }
    onChange({ ...PROP_FIRM_PRESETS[key] });
  }

  function handleEdit(next: PropFirmRules) {
    onChange(next);
    setPreset("custom");
  }

  return (
    <div className="space-y-2 border-t pt-3">
      <h4 className="text-xs font-medium text-muted-foreground">Prop Firm Rules</h4>
      <div className="flex flex-wrap gap-1">
        {(Object.keys(PROP_FIRM_LABELS) as PropFirmPreset[]).map((key) => (
          <Button
            key={key}
            size="xs"
            variant={
              (preset === key && propFirm) || (key === "custom" && !propFirm)
                ? "default"
                : "outline"
            }
            onClick={() => handlePreset(key)}
          >
            {PROP_FIRM_LABELS[key]}
          </Button>
        ))}
        {propFirm && (
          <Button
            size="xs"
            variant="ghost"
            onClick={() => {
              onChange(undefined);
              setPreset("custom");
            }}
          >
            Remove
          </Button>
        )}
      </div>
      {propFirm && <PropFirmFields values={propFirm} onChange={handleEdit} />}
    </div>
  );
}

interface RulesEditorProps {
  rules: AlgorithmRules;
  onSave: (rules: AlgorithmRules) => void;
  onCancel: () => void;
  isSaving: boolean;
}

export function RulesEditor({ rules, onSave, onCancel, isSaving }: RulesEditorProps) {
  const [draft, setDraft] = useState<AlgorithmRules>(structuredClone(rules));

  function removeEntry(index: number) {
    setDraft((d) => ({ ...d, entry_conditions: d.entry_conditions.filter((_, i) => i !== index) }));
  }

  function removeExit(index: number) {
    setDraft((d) => ({ ...d, exit_conditions: d.exit_conditions.filter((_, i) => i !== index) }));
  }

  function addEntryPattern(c: PatternCondition) {
    setDraft((d) => ({ ...d, entry_conditions: [...d.entry_conditions, c] }));
  }

  function addExitPattern(c: PatternCondition) {
    setDraft((d) => ({ ...d, exit_conditions: [...d.exit_conditions, c] }));
  }

  function updateRisk(field: "stop_loss" | "take_profit" | "position_sizing", value: number) {
    setDraft((d) => ({ ...d, [field]: { ...d[field], value } }));
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">Edit Trading Rules</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1">
          <h4 className="text-xs font-medium text-muted-foreground">Entry Conditions</h4>
          {draft.entry_conditions.map((c, i) => (
            <ConditionRow key={i} condition={c} onRemove={() => removeEntry(i)} />
          ))}
          {draft.entry_conditions.length === 0 && (
            <p className="text-xs text-muted-foreground">No entry conditions</p>
          )}
          <div className="pt-1">
            <PatternConditionForm onAdd={addEntryPattern} />
          </div>
        </div>
        <div className="space-y-1">
          <h4 className="text-xs font-medium text-muted-foreground">Exit Conditions</h4>
          {draft.exit_conditions.map((c, i) => (
            <ConditionRow key={i} condition={c} onRemove={() => removeExit(i)} />
          ))}
          {draft.exit_conditions.length === 0 && (
            <p className="text-xs text-muted-foreground">No exit conditions</p>
          )}
          <div className="pt-1">
            <PatternConditionForm onAdd={addExitPattern} />
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <NumericField
            label="Stop Loss"
            value={draft.stop_loss?.value ?? 5}
            onChange={(v) => updateRisk("stop_loss", v)}
            suffix="%"
          />
          <NumericField
            label="Take Profit"
            value={draft.take_profit?.value ?? 15}
            onChange={(v) => updateRisk("take_profit", v)}
            suffix="%"
          />
          <NumericField
            label="Position Size"
            value={draft.position_sizing?.value ?? 10}
            onChange={(v) => updateRisk("position_sizing", v)}
            suffix="% of capital"
          />
          <NumericField
            label="Max Positions"
            value={draft.max_positions ?? 3}
            onChange={(v) => setDraft((d) => ({ ...d, max_positions: v }))}
          />
        </div>
        <PropFirmSection
          propFirm={draft.prop_firm}
          onChange={(pf) => setDraft((d) => ({ ...d, prop_firm: pf }))}
        />
        <div className="flex gap-2 justify-end">
          <Button variant="outline" size="sm" onClick={onCancel} disabled={isSaving}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => onSave(draft)} disabled={isSaving}>
            {isSaving ? "Saving..." : "Save Rules"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
