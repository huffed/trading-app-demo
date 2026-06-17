"use client";

import { Grid3X3, Layers, ScanLine, TrendingUp } from "lucide-react";
import { cn } from "@/lib/utils";

export type ValidateTab = "grid" | "friction" | "cadence" | "per_window";

interface TabDef {
  key: ValidateTab;
  label: string;
  icon: typeof Grid3X3;
  enabled: boolean;
  hint?: string;
}

const TABS: TabDef[] = [
  { key: "grid", label: "RR × lookback grid", icon: Grid3X3, enabled: true },
  { key: "friction", label: "Friction", icon: ScanLine, enabled: false, hint: "Slippage + spread sensitivity. Coming next." },
  { key: "cadence", label: "Cadence", icon: TrendingUp, enabled: false, hint: "1h vs 30m vs 4h primary timeframe. Coming next." },
  { key: "per_window", label: "Per-window", icon: Layers, enabled: false, hint: "Walk-forward window decomp. Coming next." },
];

export function ValidateTabs({
  active,
  onChange,
}: {
  active: ValidateTab;
  onChange: (k: ValidateTab) => void;
}) {
  return (
    <div className="border-b">
      <div className="flex gap-1">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => t.enabled && onChange(t.key)}
            disabled={!t.enabled}
            title={t.enabled ? undefined : t.hint}
            className={cn(
              "px-3 py-2 text-xs font-medium flex items-center gap-1.5 border-b-2 transition-colors",
              active === t.key
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground",
              t.enabled ? "hover:text-foreground" : "opacity-40 cursor-not-allowed"
            )}
          >
            <t.icon className="h-3.5 w-3.5" />
            {t.label}
            {!t.enabled && (
              <span className="ml-1 rounded bg-muted px-1 text-[9px] uppercase">soon</span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
