"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  PROP_FIRM_LABELS,
  PROP_FIRM_PRESETS,
  type PropFirmPreset,
} from "@/lib/constants/prop-firm";
import type {
  AlgorithmRules,
  EntryCondition,
  ExitCondition,
  PatternCondition,
  PropFirmRules,
  SentimentCondition,
  TechnicalCondition,
} from "@/types/algorithm";
import { ConditionRow } from "./condition-row";
import { PatternConditionForm } from "./pattern-condition-form";
import { PropFirmFields } from "./prop-firm-fields";
import { SentimentConditionForm } from "./sentiment-condition-form";
import { TechnicalConditionForm } from "./technical-condition-form";

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

interface ConditionsListProps {
  title: string;
  conditions: (EntryCondition | ExitCondition)[];
  onRemove: (index: number) => void;
  onAddTechnical: (c: TechnicalCondition) => void;
  onAddPattern: (c: PatternCondition) => void;
  onAddSentiment: (c: SentimentCondition) => void;
}

function ConditionsList({
  title,
  conditions,
  onRemove,
  onAddTechnical,
  onAddPattern,
  onAddSentiment,
}: ConditionsListProps) {
  return (
    <div className="space-y-1">
      <h4 className="text-xs font-medium text-muted-foreground">{title}</h4>
      {conditions.map((c, i) => (
        <ConditionRow key={i} condition={c} onRemove={() => onRemove(i)} />
      ))}
      {conditions.length === 0 && (
        <p className="text-xs text-muted-foreground">No {title.toLowerCase()}</p>
      )}
      <div className="pt-1 flex flex-wrap gap-2">
        <TechnicalConditionForm onAdd={onAddTechnical} />
        <PatternConditionForm onAdd={onAddPattern} />
        <SentimentConditionForm onAdd={onAddSentiment} />
      </div>
    </div>
  );
}

function RiskGrid({
  draft,
  setDraft,
}: {
  draft: AlgorithmRules;
  setDraft: (next: (d: AlgorithmRules) => AlgorithmRules) => void;
}) {
  function updateRisk(field: "stop_loss" | "take_profit" | "position_sizing", value: number) {
    setDraft((d) => ({ ...d, [field]: { ...d[field], value } }));
  }
  return (
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

  const addEntry = (c: EntryCondition) =>
    setDraft((d) => ({ ...d, entry_conditions: [...d.entry_conditions, c] }));
  const addExit = (c: ExitCondition) =>
    setDraft((d) => ({ ...d, exit_conditions: [...d.exit_conditions, c] }));
  const removeEntry = (i: number) =>
    setDraft((d) => ({ ...d, entry_conditions: d.entry_conditions.filter((_, x) => x !== i) }));
  const removeExit = (i: number) =>
    setDraft((d) => ({ ...d, exit_conditions: d.exit_conditions.filter((_, x) => x !== i) }));

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">Edit Trading Rules</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <ConditionsList
          title="Entry Conditions"
          conditions={draft.entry_conditions}
          onRemove={removeEntry}
          onAddTechnical={addEntry}
          onAddPattern={addEntry}
          onAddSentiment={addEntry}
        />
        <ConditionsList
          title="Exit Conditions"
          conditions={draft.exit_conditions}
          onRemove={removeExit}
          onAddTechnical={addExit}
          onAddPattern={addExit}
          onAddSentiment={addExit}
        />
        <RiskGrid draft={draft} setDraft={setDraft} />
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
