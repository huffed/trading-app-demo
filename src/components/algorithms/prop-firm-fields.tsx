"use client";

import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { PropFirmRules } from "@/types/algorithm";
import { NumericOverride } from "./generate-form-sections";

function LossUnitSelect({
  values,
  onChange,
}: {
  values: PropFirmRules;
  onChange: (next: PropFirmRules) => void;
}) {
  const unit = values.consecutive_loss_unit ?? "trades";
  return (
    <div className="space-y-1">
      <Label className="text-xs text-muted-foreground">Loss unit</Label>
      <Select
        value={unit}
        onValueChange={(v) =>
          v && onChange({ ...values, consecutive_loss_unit: v as "trades" | "days" })
        }
      >
        <SelectTrigger className="w-full">
          <SelectValue>{unit}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="trades">trades (per-position)</SelectItem>
          <SelectItem value="days">days (per calendar day)</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}

export function PropFirmFields({
  values,
  onChange,
}: {
  values: PropFirmRules;
  onChange: (next: PropFirmRules) => void;
}) {
  function set<K extends keyof PropFirmRules>(field: K, v: string) {
    const n = Number(v);
    if (!isNaN(n)) onChange({ ...values, [field]: n });
  }
  const unit = values.consecutive_loss_unit ?? "trades";

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <NumericOverride
        label="Daily Loss Limit"
        value={String(values.daily_loss_limit)}
        placeholder=""
        suffix="%"
        onChange={(v) => set("daily_loss_limit", v)}
      />
      <NumericOverride
        label="Max Drawdown"
        value={String(values.max_drawdown)}
        placeholder=""
        suffix="%"
        onChange={(v) => set("max_drawdown", v)}
      />
      <NumericOverride
        label="Profit Target"
        value={String(values.profit_target)}
        placeholder=""
        suffix="%"
        onChange={(v) => set("profit_target", v)}
      />
      <NumericOverride
        label="Kill switch (0 = off)"
        value={String(values.max_consecutive_losses)}
        placeholder=""
        suffix={`consec ${unit}`}
        onChange={(v) => set("max_consecutive_losses", v)}
      />
      <LossUnitSelect values={values} onChange={onChange} />
      <NumericOverride
        label="Consistency Rule"
        value={String(values.consistency_rule)}
        placeholder=""
        suffix="% max day"
        onChange={(v) => set("consistency_rule", v)}
      />
      <NumericOverride
        label="Slippage"
        value={String(values.slippage_bps)}
        placeholder=""
        suffix="bps"
        onChange={(v) => set("slippage_bps", v)}
      />
      <NumericOverride
        label="Commission"
        value={String(values.commission_pct)}
        placeholder=""
        suffix="% per trade"
        onChange={(v) => set("commission_pct", v)}
      />
    </div>
  );
}
