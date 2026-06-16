"use client";

import { ChevronDown, ChevronUp, Newspaper } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { NewsVetoRules } from "@/types/algorithm";
import { NumericOverride } from "./numeric-override";

export const DEFAULT_NEWS_VETO: NewsVetoRules = {
  enabled: true,
  block_minutes_before: 15,
  block_minutes_after: 30,
  min_impact: "high",
};

function NewsVetoFields({
  v,
  onChange,
}: {
  v: NewsVetoRules;
  onChange: (next: NewsVetoRules) => void;
}) {
  function set<K extends keyof NewsVetoRules>(field: K, val: NewsVetoRules[K]) {
    onChange({ ...v, [field]: val });
  }

  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <NumericOverride
        label="Block before"
        value={String(v.block_minutes_before)}
        placeholder=""
        suffix="min"
        onChange={(s) => set("block_minutes_before", Number(s) || 0)}
      />
      <NumericOverride
        label="Block after"
        value={String(v.block_minutes_after)}
        placeholder=""
        suffix="min"
        onChange={(s) => set("block_minutes_after", Number(s) || 0)}
      />
      <div className="space-y-1">
        <Label className="text-xs text-muted-foreground">Min impact</Label>
        <Select
          value={v.min_impact}
          onValueChange={(next) =>
            next && set("min_impact", next as NewsVetoRules["min_impact"])
          }
        >
          <SelectTrigger className="w-full">
            <SelectValue>{v.min_impact}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="low">low</SelectItem>
            <SelectItem value="medium">medium</SelectItem>
            <SelectItem value="high">high</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

export function NewsVetoSection({
  open,
  onToggle,
  values,
  onChange,
}: {
  open: boolean;
  onToggle: () => void;
  values: NewsVetoRules | null;
  onChange: (v: NewsVetoRules | null) => void;
}) {
  const enabled = values?.enabled ?? false;
  const v = values ?? DEFAULT_NEWS_VETO;

  return (
    <div className="rounded-md border">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between px-3 py-2 text-sm font-medium"
      >
        <span className="flex items-center gap-2">
          <Newspaper className="h-3.5 w-3.5 text-muted-foreground" />
          News protection
          {enabled && (
            <span className="text-xs font-normal text-muted-foreground">
              (-{v.block_minutes_before}m / +{v.block_minutes_after}m, {v.min_impact}+)
            </span>
          )}
        </span>
        {open ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
      </button>
      {open && (
        <div className="space-y-3 border-t p-3">
          <p className="text-xs text-muted-foreground">
            Blocks new entries inside a window around major economic releases (CPI, NFP, FOMC etc.)
            for the symbol&apos;s currencies. Recommended for forex and commodity strategies.
          </p>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="xs"
              variant={enabled ? "default" : "outline"}
              onClick={() => onChange({ ...v, enabled: true })}
            >
              On
            </Button>
            <Button
              type="button"
              size="xs"
              variant={!enabled ? "default" : "outline"}
              onClick={() => onChange(null)}
            >
              Off
            </Button>
          </div>
          {enabled && <NewsVetoFields v={v} onChange={onChange} />}
        </div>
      )}
    </div>
  );
}
