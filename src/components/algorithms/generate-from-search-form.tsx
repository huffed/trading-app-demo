"use client";

import { useState } from "react";
import type { GenerateFromSearchInput } from "@/app/(dashboard)/algorithms/generate-from-search-actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

interface Props {
  onSubmit: (input: GenerateFromSearchInput) => void;
  disabled: boolean;
}

const ASSET_CLASS_OPTIONS = [
  { value: "forex", label: "Forex (14 majors + crosses)" },
  { value: "commodity", label: "Commodities (gold, silver, oil, gas)" },
];

/**
 * Form for the Wave 7 search-driven algorithm flow. Three inputs only,
 * matching the operator's product framing: capital, monthly target, and
 * optional prefer/avoid filters. The system handles everything else
 * (timeframe, conditions, SL/TP, sizing, watchlist) via the
 * combinatorial search engine.
 */
function AssetClassCheckboxes({
  classes,
  toggle,
  disabled,
}: {
  classes: Set<string>;
  toggle: (v: string) => void;
  disabled: boolean;
}) {
  return (
    <div className="space-y-2">
      <Label>Asset classes (used when no specific symbols are listed)</Label>
      {ASSET_CLASS_OPTIONS.map((opt) => (
        <label key={opt.value} className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="h-4 w-4 rounded border-border accent-primary"
            checked={classes.has(opt.value)}
            onChange={() => toggle(opt.value)}
            disabled={disabled}
          />
          {opt.label}
        </label>
      ))}
    </div>
  );
}

function buildInput(state: {
  capital: string;
  monthlyTarget: string;
  name: string;
  classes: Set<string>;
  preferSymbols: string;
}): GenerateFromSearchInput | null {
  const cap = Number(state.capital);
  const target = Number(state.monthlyTarget);
  if (!Number.isFinite(cap) || cap <= 0) return null;
  if (!Number.isFinite(target) || target <= 0) return null;
  const syms = state.preferSymbols
    .split(/[\s,]+/)
    .map((s) => s.trim().toUpperCase())
    .filter((s) => s.length > 0);
  return {
    capital: cap,
    monthly_target_pct: target,
    ...(state.name.trim() ? { name: state.name.trim() } : {}),
    ...(syms.length > 0
      ? { prefer_symbols: syms }
      : { prefer_asset_classes: Array.from(state.classes) }),
  };
}

export function GenerateFromSearchForm({ onSubmit, disabled }: Props) {
  const [capital, setCapital] = useState("20000");
  const [monthlyTarget, setMonthlyTarget] = useState("5");
  const [name, setName] = useState("");
  const [classes, setClasses] = useState<Set<string>>(new Set(["forex", "commodity"]));
  const [preferSymbols, setPreferSymbols] = useState("");

  function toggleClass(v: string) {
    const next = new Set(classes);
    if (next.has(v)) next.delete(v);
    else next.add(v);
    setClasses(next);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const input = buildInput({ capital, monthlyTarget, name, classes, preferSymbols });
    if (input) onSubmit(input);
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <NameField name={name} setName={setName} disabled={disabled} />
      <CapitalAndTarget
        capital={capital}
        setCapital={setCapital}
        monthlyTarget={monthlyTarget}
        setMonthlyTarget={setMonthlyTarget}
        disabled={disabled}
      />
      <AssetClassCheckboxes
        classes={classes}
        toggle={toggleClass}
        disabled={disabled || preferSymbols.trim().length > 0}
      />
      <SymbolsField
        preferSymbols={preferSymbols}
        setPreferSymbols={setPreferSymbols}
        disabled={disabled}
      />
      <Button type="submit" disabled={disabled} className="w-full">
        {disabled ? "Searching…" : "Search & generate"}
      </Button>
    </form>
  );
}

function NameField({
  name,
  setName,
  disabled,
}: {
  name: string;
  setName: (v: string) => void;
  disabled: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor="search_name">Name (optional)</Label>
      <Input
        id="search_name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Auto-generated from the picked template"
        maxLength={80}
        disabled={disabled}
      />
    </div>
  );
}

function CapitalAndTarget({
  capital,
  setCapital,
  monthlyTarget,
  setMonthlyTarget,
  disabled,
}: {
  capital: string;
  setCapital: (v: string) => void;
  monthlyTarget: string;
  setMonthlyTarget: (v: string) => void;
  disabled: boolean;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="space-y-1.5">
        <Label htmlFor="search_capital">Capital ($)</Label>
        <Input
          id="search_capital"
          type="number"
          value={capital}
          onChange={(e) => setCapital(e.target.value)}
          min={100}
          max={1_000_000}
          step={100}
          disabled={disabled}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="search_target">Monthly target (%)</Label>
        <Input
          id="search_target"
          type="number"
          value={monthlyTarget}
          onChange={(e) => setMonthlyTarget(e.target.value)}
          min={0.5}
          max={50}
          step={0.5}
          disabled={disabled}
        />
      </div>
    </div>
  );
}

function SymbolsField({
  preferSymbols,
  setPreferSymbols,
  disabled,
}: {
  preferSymbols: string;
  setPreferSymbols: (v: string) => void;
  disabled: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor="search_symbols">Prefer specific symbols (optional)</Label>
      <Textarea
        id="search_symbols"
        value={preferSymbols}
        onChange={(e) => setPreferSymbols(e.target.value)}
        placeholder="EUR/USD, XAU/USD, GBP/USD"
        rows={2}
        disabled={disabled}
      />
      <p className="text-xs text-muted-foreground">
        Overrides asset classes. Comma or space separated.
      </p>
    </div>
  );
}
