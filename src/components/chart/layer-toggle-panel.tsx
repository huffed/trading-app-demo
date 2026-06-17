"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight, Sliders } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  DEFAULT_LAYERS,
  GROUP_LABELS,
  LAYER_META,
  type LayerConfig,
  type LayerGroup,
} from "./layer-config";

const GROUP_ORDER: LayerGroup[] = ["indicators", "oscillators", "patterns", "trades"];

/** Collapsible card with grouped layer toggles. Each layer has a color
 *  swatch matching its on-chart appearance so the operator can pre-read
 *  the legend without flipping it on. */
export function LayerTogglePanel({
  layers,
  onChange,
}: {
  layers: LayerConfig;
  onChange: (next: LayerConfig) => void;
}) {
  const [open, setOpen] = useState(true);
  const grouped: Record<LayerGroup, (keyof LayerConfig)[]> = {
    indicators: [],
    oscillators: [],
    patterns: [],
    trades: [],
  };
  for (const k of Object.keys(LAYER_META) as (keyof LayerConfig)[]) {
    grouped[LAYER_META[k].group].push(k);
  }

  const enabledCount = Object.values(layers).filter(Boolean).length;
  const totalCount = Object.keys(layers).length;

  return (
    <Card>
      <CardHeader
        className="cursor-pointer py-3 select-none"
        onClick={() => setOpen((v) => !v)}
      >
        <CardTitle className="text-sm font-medium flex items-center justify-between">
          <span className="flex items-center gap-2">
            {open ? (
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            )}
            <Sliders className="h-4 w-4 text-muted-foreground" />
            Layers
            <span className="text-xs text-muted-foreground font-normal">
              ({enabledCount}/{totalCount} enabled)
            </span>
          </span>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onChange({ ...DEFAULT_LAYERS });
            }}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            Reset defaults
          </button>
        </CardTitle>
      </CardHeader>
      {open && (
        <CardContent className="space-y-3 pt-0">
          {GROUP_ORDER.map((group) => (
            <div key={group}>
              <h4 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">
                {GROUP_LABELS[group]}
              </h4>
              <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {grouped[group].map((key) => (
                  <LayerToggle
                    key={key}
                    layerKey={key}
                    on={layers[key]}
                    onChange={(v) => onChange({ ...layers, [key]: v })}
                  />
                ))}
              </div>
            </div>
          ))}
        </CardContent>
      )}
    </Card>
  );
}

function LayerToggle({
  layerKey,
  on,
  onChange,
}: {
  layerKey: keyof LayerConfig;
  on: boolean;
  onChange: (v: boolean) => void;
}) {
  const meta = LAYER_META[layerKey];
  return (
    <label
      className={`flex items-center gap-2 rounded-md border px-2 py-1.5 cursor-pointer transition-colors ${
        on ? "bg-muted/40 border-primary/30" : "hover:bg-muted/30"
      }`}
    >
      <input
        type="checkbox"
        checked={on}
        onChange={(e) => onChange(e.target.checked)}
        className="h-3.5 w-3.5 accent-current"
      />
      <span
        className="h-2.5 w-2.5 rounded-sm shrink-0"
        style={{ backgroundColor: meta.color }}
      />
      <span className="text-xs">{meta.label}</span>
    </label>
  );
}
