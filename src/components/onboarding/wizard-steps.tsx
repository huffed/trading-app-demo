"use client";

import { useState } from "react";
import { Check } from "lucide-react";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  CAPITAL_PRESETS,
  EXPERIENCE_LABELS,
  GOAL_DESCRIPTIONS,
  GOAL_LABELS,
  INTEREST_LABELS,
  RISK_COMFORT_DESCRIPTIONS,
  RISK_COMFORT_LABELS,
  TIME_COMMITMENT_DESCRIPTIONS,
  TIME_COMMITMENT_LABELS,
} from "@/lib/constants/onboarding";
import { PROP_FIRM_LABELS, type PropFirmPreset } from "@/lib/constants/prop-firm";
import type { TradingProfileAnswers } from "@/types/trading-profile";

export function OptionButton({
  selected,
  onClick,
  label,
  description,
}: {
  selected: boolean;
  onClick: () => void;
  label: string;
  description?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full rounded-lg border p-3 text-left transition-colors cursor-pointer ${
        selected
          ? "border-primary bg-primary/5 ring-1 ring-primary"
          : "border-border hover:border-foreground/20"
      }`}
    >
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">{label}</span>
        {selected && <Check className="h-4 w-4 text-primary" />}
      </div>
      {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
    </button>
  );
}

export function StepGoal({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: TradingProfileAnswers["goal"]) => void;
}) {
  return (
    <div className="space-y-2">
      {Object.entries(GOAL_LABELS).map(([key, label]) => (
        <OptionButton
          key={key}
          selected={value === key}
          onClick={() => onChange(key as TradingProfileAnswers["goal"])}
          label={label}
          description={GOAL_DESCRIPTIONS[key]}
        />
      ))}
    </div>
  );
}

export function StepRisk({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: TradingProfileAnswers["risk_comfort"]) => void;
}) {
  return (
    <div className="space-y-2">
      {Object.entries(RISK_COMFORT_LABELS).map(([key, label]) => (
        <OptionButton
          key={key}
          selected={value === key}
          onClick={() => onChange(key as TradingProfileAnswers["risk_comfort"])}
          label={label}
          description={RISK_COMFORT_DESCRIPTIONS[key]}
        />
      ))}
    </div>
  );
}

export function StepCapital({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const [custom, setCustom] = useState(false);
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-2">
        {CAPITAL_PRESETS.map((amount) => (
          <button
            key={amount}
            type="button"
            onClick={() => {
              setCustom(false);
              onChange(amount);
            }}
            className={`rounded-lg border p-2.5 text-sm font-medium transition-colors cursor-pointer ${
              value === amount && !custom
                ? "border-primary bg-primary/5 ring-1 ring-primary"
                : "border-border hover:border-foreground/20"
            }`}
          >
            ${amount.toLocaleString()}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setCustom(true)}
          className={`rounded-lg border p-2.5 text-sm font-medium transition-colors cursor-pointer ${
            custom
              ? "border-primary bg-primary/5 ring-1 ring-primary"
              : "border-border hover:border-foreground/20"
          }`}
        >
          Custom
        </button>
      </div>
      {custom && (
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">$</span>
          <Input
            type="number"
            min={50}
            max={1_000_000}
            value={value}
            onChange={(e) => onChange(Number(e.target.value) || 0)}
            autoFocus
          />
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        This is simulated — no real money is used until you connect a broker.
      </p>
    </div>
  );
}

export function StepInterests({
  value,
  onChange,
}: {
  value: string[];
  onChange: (v: string[]) => void;
}) {
  function toggle(key: string) {
    if (key === "ai_picks") {
      onChange(value.includes("ai_picks") ? [] : ["ai_picks"]);
      return;
    }
    const without = value.filter((v) => v !== "ai_picks");
    onChange(without.includes(key) ? without.filter((v) => v !== key) : [...without, key]);
  }

  return (
    <div className="grid grid-cols-2 gap-2">
      {Object.entries(INTEREST_LABELS).map(([key, label]) => (
        <button
          key={key}
          type="button"
          onClick={() => toggle(key)}
          className={`rounded-lg border p-2.5 text-left text-sm transition-colors cursor-pointer ${
            value.includes(key)
              ? "border-primary bg-primary/5 ring-1 ring-primary"
              : "border-border hover:border-foreground/20"
          }`}
        >
          <div className="flex items-center justify-between">
            <span className="font-medium">{label}</span>
            {value.includes(key) && <Check className="h-3.5 w-3.5 text-primary" />}
          </div>
        </button>
      ))}
    </div>
  );
}

export function StepTime({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: TradingProfileAnswers["time_commitment"]) => void;
}) {
  return (
    <div className="space-y-2">
      {Object.entries(TIME_COMMITMENT_LABELS).map(([key, label]) => (
        <OptionButton
          key={key}
          selected={value === key}
          onClick={() => onChange(key as TradingProfileAnswers["time_commitment"])}
          label={label}
          description={TIME_COMMITMENT_DESCRIPTIONS[key]}
        />
      ))}
    </div>
  );
}

export function StepExperience({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: TradingProfileAnswers["experience_level"]) => void;
}) {
  return (
    <div className="space-y-2">
      {Object.entries(EXPERIENCE_LABELS).map(([key, label]) => (
        <OptionButton
          key={key}
          selected={value === key}
          onClick={() => onChange(key as TradingProfileAnswers["experience_level"])}
          label={label}
        />
      ))}
    </div>
  );
}

export function StepFundedAccount({
  value,
  onChange,
}: {
  value: TradingProfileAnswers["funded_account"];
  onChange: (v: TradingProfileAnswers["funded_account"]) => void;
}) {
  const enabled = value?.enabled ?? false;
  const preset = value?.preset ?? "ftmo";
  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <OptionButton
          selected={!enabled}
          onClick={() => onChange({ enabled: false, preset: null })}
          label="No — retail account"
          description="No prop-firm constraints; use standard risk defaults."
        />
        <OptionButton
          selected={enabled}
          onClick={() => onChange({ enabled: true, preset })}
          label="Yes — funded prop-firm account"
          description="FTMO / Topstep / FundedNext / The5ers — adds daily-loss limit, drawdown, profit target rules to every algorithm."
        />
      </div>
      {enabled && (
        <div className="space-y-1.5 rounded-md border p-2.5">
          <p className="text-xs font-medium">Which prop firm?</p>
          <Select
            value={preset}
            onValueChange={(v) =>
              v && onChange({ enabled: true, preset: v as PropFirmPreset })
            }
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(PROP_FIRM_LABELS) as PropFirmPreset[]).map((k) => (
                <SelectItem key={k} value={k}>
                  {PROP_FIRM_LABELS[k]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-[11px] text-muted-foreground">
            Sets your default — change later in Settings → Pro-account preferences.
          </p>
        </div>
      )}
    </div>
  );
}

export { ONBOARDING_STEP_CONFIG as STEP_CONFIG } from "@/lib/constants/onboarding";
