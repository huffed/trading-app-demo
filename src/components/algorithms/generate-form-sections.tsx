"use client";

import { ChevronDown, ChevronUp, ShieldAlert, Sliders } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  PROP_FIRM_LABELS,
  PROP_FIRM_PRESETS,
  type PropFirmPreset,
} from "@/lib/constants/prop-firm";
import type { AlgorithmFormValues } from "@/lib/validators/algorithm";
import type { PropFirmRules } from "@/types/algorithm";
import { PropFirmFields } from "./prop-firm-fields";

export interface OverrideState {
  stop_loss: string;
  take_profit: string;
  position_size: string;
  max_positions: string;
  max_per_ticker: string;
}

export const EMPTY_OVERRIDES: OverrideState = {
  stop_loss: "",
  take_profit: "",
  position_size: "",
  max_positions: "",
  max_per_ticker: "",
};

export function NumericOverride({
  label,
  value,
  placeholder,
  suffix,
  onChange,
}: {
  label: string;
  value: string;
  placeholder: string;
  suffix?: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <div className="flex items-center gap-1.5">
        <Input
          type="number"
          step="any"
          min={0}
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
        {suffix && <span className="text-xs text-muted-foreground">{suffix}</span>}
      </div>
    </div>
  );
}

export function AdvancedSection({
  open,
  onToggle,
  overrides,
  setOverrides,
}: {
  open: boolean;
  onToggle: () => void;
  overrides: OverrideState;
  setOverrides: (o: OverrideState) => void;
}) {
  return (
    <div className="rounded-md border">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between px-3 py-2 text-sm font-medium"
      >
        <span className="flex items-center gap-2">
          <Sliders className="h-3.5 w-3.5 text-muted-foreground" />
          Advanced — manual overrides
        </span>
        {open ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
      </button>
      {open && (
        <div className="space-y-3 border-t p-3">
          <p className="text-xs text-muted-foreground">
            Leave any field blank to let the AI choose. Filled values override the AI&apos;s output.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <NumericOverride
              label="Stop Loss"
              value={overrides.stop_loss}
              placeholder="AI default"
              suffix="%"
              onChange={(v) => setOverrides({ ...overrides, stop_loss: v })}
            />
            <NumericOverride
              label="Take Profit"
              value={overrides.take_profit}
              placeholder="AI default"
              suffix="%"
              onChange={(v) => setOverrides({ ...overrides, take_profit: v })}
            />
            <NumericOverride
              label="Position Size"
              value={overrides.position_size}
              placeholder="AI default"
              suffix="% of capital"
              onChange={(v) => setOverrides({ ...overrides, position_size: v })}
            />
            <NumericOverride
              label="Max Positions"
              value={overrides.max_positions}
              placeholder="AI default"
              onChange={(v) => setOverrides({ ...overrides, max_positions: v })}
            />
            <NumericOverride
              label="Max Per Ticker (pyramiding)"
              value={overrides.max_per_ticker}
              placeholder="1 = no stacking"
              onChange={(v) => setOverrides({ ...overrides, max_per_ticker: v })}
            />
          </div>
        </div>
      )}
    </div>
  );
}

export function PropFirmSection({
  open,
  onToggle,
  preset,
  values,
  onPreset,
  onChangeValues,
}: {
  open: boolean;
  onToggle: () => void;
  preset: PropFirmPreset | null;
  values: PropFirmRules | null;
  onPreset: (p: PropFirmPreset | null) => void;
  onChangeValues: (v: PropFirmRules) => void;
}) {
  return (
    <div className="rounded-md border">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between px-3 py-2 text-sm font-medium"
      >
        <span className="flex items-center gap-2">
          <ShieldAlert className="h-3.5 w-3.5 text-muted-foreground" />
          Funded / prop-firm rules
          {values && (
            <span className="text-xs font-normal text-muted-foreground">
              ({preset ? PROP_FIRM_LABELS[preset] : "configured"})
            </span>
          )}
        </span>
        {open ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
      </button>
      {open && (
        <div className="space-y-3 border-t p-3">
          <p className="text-xs text-muted-foreground">
            Pick a preset or build a custom rule set. The backtest engine enforces these limits and
            the AI uses them to shape strategy generation.
          </p>
          <div className="flex flex-wrap gap-1">
            <Button
              type="button"
              size="xs"
              variant={preset === null && !values ? "default" : "outline"}
              onClick={() => onPreset(null)}
            >
              None
            </Button>
            {(["ftmo", "topstep", "funded_next", "the5ers", "custom"] as PropFirmPreset[]).map(
              (key) => (
                <Button
                  key={key}
                  type="button"
                  size="xs"
                  variant={preset === key ? "default" : "outline"}
                  onClick={() => onPreset(key)}
                >
                  {PROP_FIRM_LABELS[key]}
                </Button>
              )
            )}
          </div>
          {values && <PropFirmFields values={values} onChange={onChangeValues} />}
        </div>
      )}
    </div>
  );
}

export function buildOverrides(o: OverrideState): AlgorithmFormValues["overrides"] {
  const out: NonNullable<AlgorithmFormValues["overrides"]> = {};
  const num = (s: string) => (s.trim() === "" ? undefined : Number(s));
  const fields: (keyof OverrideState)[] = [
    "stop_loss",
    "take_profit",
    "position_size",
    "max_positions",
    "max_per_ticker",
  ];
  for (const f of fields) {
    const n = num(o[f]);
    if (n != null && !isNaN(n) && n > 0) {
      out[f] = n;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Drives the prop-firm preset → values relationship, consumed by GenerateForm. */
export function applyPropFirmPreset(
  next: PropFirmPreset | null,
  current: PropFirmRules | null
): { preset: PropFirmPreset | null; values: PropFirmRules | null } {
  if (next === null) return { preset: null, values: null };
  if (next === "custom") {
    return { preset: "custom", values: current ?? { ...PROP_FIRM_PRESETS.ftmo } };
  }
  return { preset: next, values: { ...PROP_FIRM_PRESETS[next] } };
}

