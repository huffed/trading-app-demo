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
import { NumericOverride } from "./numeric-override";

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

/** Subtle group header inside the PropFirm rules panel. Visually distinct
 *  from the section header but quieter than a CardTitle. Helps the operator
 *  scan "what kind of field am I editing" without a heavy border or
 *  collapsible chrome. */
function GroupHeader({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="flex items-baseline justify-between border-b pb-1 mb-2">
      <h5 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h5>
      <p className="text-[10px] text-muted-foreground/70">{hint}</p>
    </div>
  );
}

type SetFn = (field: keyof PropFirmRules, v: string) => void;

function AccountLimitsGroup({ values, set }: { values: PropFirmRules; set: SetFn }) {
  return (
    <div>
      <GroupHeader title="Account limits" hint="FTMO challenge thresholds" />
      <div className="grid gap-3 sm:grid-cols-3">
        <NumericOverride
          label="Daily loss limit"
          value={String(values.daily_loss_limit)}
          placeholder=""
          suffix="%"
          onChange={(v) => set("daily_loss_limit", v)}
        />
        <NumericOverride
          label="Max drawdown"
          value={String(values.max_drawdown)}
          placeholder=""
          suffix="%"
          onChange={(v) => set("max_drawdown", v)}
        />
        <NumericOverride
          label="Profit target"
          value={String(values.profit_target)}
          placeholder=""
          suffix="%"
          onChange={(v) => set("profit_target", v)}
        />
      </div>
    </div>
  );
}

function HaltRulesGroup({
  values,
  set,
  onChange,
}: {
  values: PropFirmRules;
  set: SetFn;
  onChange: (next: PropFirmRules) => void;
}) {
  const unit = values.consecutive_loss_unit ?? "trades";
  return (
    <div>
      <GroupHeader title="Halt rules" hint="Circuit breakers" />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <NumericOverride
          label="Kill switch"
          value={String(values.max_consecutive_losses)}
          placeholder="0 = off"
          suffix={`consec ${unit}`}
          onChange={(v) => set("max_consecutive_losses", v)}
        />
        <LossUnitSelect values={values} onChange={onChange} />
        <NumericOverride
          label="DLL halt buffer"
          value={String(values.daily_loss_halt_pct ?? 100)}
          placeholder="100 = halt at DLL"
          suffix="% of DLL"
          onChange={(v) => set("daily_loss_halt_pct", v)}
        />
        <NumericOverride
          label="Consistency rule"
          value={String(values.consistency_rule)}
          placeholder=""
          suffix="% max day"
          onChange={(v) => set("consistency_rule", v)}
        />
      </div>
    </div>
  );
}

function ExecutionCostsGroup({ values, set }: { values: PropFirmRules; set: SetFn }) {
  return (
    <div>
      <GroupHeader title="Execution costs" hint="Slippage + commission" />
      <div className="grid gap-3 sm:grid-cols-2">
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
  const set: SetFn = (field, v) => {
    const n = Number(v);
    if (!isNaN(n)) onChange({ ...values, [field]: n });
  };
  return (
    <div className="space-y-5">
      <AccountLimitsGroup values={values} set={set} />
      <HaltRulesGroup values={values} set={set} onChange={onChange} />
      <ExecutionCostsGroup values={values} set={set} />
    </div>
  );
}
