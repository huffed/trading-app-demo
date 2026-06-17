"use client";

import { useState } from "react";
import { ChevronLeft, ChevronRight, Sliders } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DEFAULT_LAYERS,
  GROUP_LABELS,
  LAYER_META,
  type LayerConfig,
  type LayerGroup,
} from "./layer-config";

const GROUP_ORDER: LayerGroup[] = ["indicators", "oscillators", "patterns", "trades"];

/** Vertical layers rail meant to live INSIDE the chart card (sibling
 *  of <KlineChart />). Click the chevron to collapse to a 36px stub
 *  that shows just the toggle icon — chart fills the freed width. */
export function ChartLayersRail({
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
  const enabled = Object.values(layers).filter(Boolean).length;
  const total = Object.keys(layers).length;

  if (!open) return <CollapsedRail enabled={enabled} total={total} onOpen={() => setOpen(true)} />;
  return (
    <ExpandedRail
      layers={layers}
      onChange={onChange}
      grouped={grouped}
      enabled={enabled}
      total={total}
      onClose={() => setOpen(false)}
    />
  );
}

function CollapsedRail({
  enabled,
  total,
  onOpen,
}: {
  enabled: number;
  total: number;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-9 shrink-0 flex-col items-center gap-2 rounded-md border bg-background/60 py-3 hover:bg-muted/40 transition-colors"
      title="Show layers"
    >
      <ChevronLeft className="h-4 w-4 text-muted-foreground" />
      <Sliders className="h-4 w-4 text-muted-foreground" />
      <span className="text-[10px] text-muted-foreground tabular-nums">
        {enabled}
        <span className="text-muted-foreground/60">/{total}</span>
      </span>
    </button>
  );
}

function ExpandedRail({
  layers,
  onChange,
  grouped,
  enabled,
  total,
  onClose,
}: {
  layers: LayerConfig;
  onChange: (next: LayerConfig) => void;
  grouped: Record<LayerGroup, (keyof LayerConfig)[]>;
  enabled: number;
  total: number;
  onClose: () => void;
}) {
  return (
    <div className="w-[220px] shrink-0 rounded-md border bg-background/60 flex flex-col">
      <RailHeader enabled={enabled} total={total} onReset={() => onChange({ ...DEFAULT_LAYERS })} onClose={onClose} />
      <div className="flex-1 overflow-y-auto px-2 py-2 space-y-3">
        {GROUP_ORDER.map((group) => (
          <div key={group}>
            <h4 className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              {GROUP_LABELS[group]}
            </h4>
            <ul className="space-y-0.5">
              {grouped[group].map((key) => (
                <LayerRow
                  key={key}
                  layerKey={key}
                  on={layers[key]}
                  onChange={(v) => onChange({ ...layers, [key]: v })}
                />
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}

function RailHeader({
  enabled,
  total,
  onReset,
  onClose,
}: {
  enabled: number;
  total: number;
  onReset: () => void;
  onClose: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2 px-2 py-2 border-b">
      <span className="flex items-center gap-1.5 text-xs font-medium">
        <Sliders className="h-3.5 w-3.5 text-muted-foreground" />
        Layers
        <span className="text-[10px] text-muted-foreground font-normal">
          ({enabled}/{total})
        </span>
      </span>
      <div className="flex items-center gap-1">
        <Button
          size="xs"
          variant="ghost"
          className="h-6 px-1.5 text-[10px]"
          onClick={onReset}
          title="Reset to defaults"
        >
          Reset
        </Button>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-1 hover:bg-muted/60"
          title="Hide layers"
        >
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
        </button>
      </div>
    </div>
  );
}

function LayerRow({
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
    <li>
      <label
        className={`flex items-center gap-2 rounded px-1.5 py-1 cursor-pointer transition-colors text-[11px] ${
          on ? "bg-muted/50" : "hover:bg-muted/30"
        }`}
      >
        <input
          type="checkbox"
          checked={on}
          onChange={(e) => onChange(e.target.checked)}
          className="h-3 w-3 accent-current"
        />
        <span
          className="h-2 w-2 rounded-sm shrink-0"
          style={{ backgroundColor: meta.color }}
        />
        <span className="truncate">{meta.label}</span>
      </label>
    </li>
  );
}
