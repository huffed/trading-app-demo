"use client";

import { Button } from "@/components/ui/button";
import { formatPriceValue } from "@/lib/utils/pnl";
import type { ChartPoint, ChartView } from "./position-chart-render";

interface ChartTooltipPayload {
  payload: ChartPoint;
}

export function ChartTooltip({
  active,
  payload,
  symbol,
  view,
}: {
  active?: boolean;
  payload?: ChartTooltipPayload[];
  symbol: string;
  view: ChartView;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const p = payload[0].payload;
  const stamp = new Date(p.date).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  if (view === "line") {
    return (
      <div className="rounded-md border bg-background px-2 py-1.5 text-xs shadow-sm">
        <div className="text-muted-foreground tabular-nums">{stamp}</div>
        <div className="font-medium tabular-nums">{formatPriceValue(symbol, p.close)}</div>
      </div>
    );
  }
  const isBull = p.close >= p.open;
  return (
    <div className="rounded-md border bg-background px-2 py-1.5 text-xs shadow-sm tabular-nums space-y-0.5">
      <div className="text-muted-foreground">{stamp}</div>
      <div className="grid grid-cols-2 gap-x-3">
        <span className="text-muted-foreground">O</span>
        <span>{formatPriceValue(symbol, p.open)}</span>
        <span className="text-muted-foreground">H</span>
        <span>{formatPriceValue(symbol, p.high)}</span>
        <span className="text-muted-foreground">L</span>
        <span>{formatPriceValue(symbol, p.low)}</span>
        <span className="text-muted-foreground">C</span>
        <span className={isBull ? "text-[var(--profit)]" : "text-[var(--loss)]"}>
          {formatPriceValue(symbol, p.close)}
        </span>
      </div>
    </div>
  );
}

function ViewToggle({ value, onChange }: { value: ChartView; onChange: (v: ChartView) => void }) {
  return (
    <div className="ml-auto inline-flex items-center rounded-md border p-0.5">
      <Button
        size="sm"
        variant={value === "line" ? "default" : "ghost"}
        className="h-6 px-2 text-[11px]"
        onClick={() => onChange("line")}
      >
        Line
      </Button>
      <Button
        size="sm"
        variant={value === "candle" ? "default" : "ghost"}
        className="h-6 px-2 text-[11px]"
        onClick={() => onChange("candle")}
      >
        Candle
      </Button>
    </div>
  );
}

function ViewLegend({ view }: { view: ChartView }) {
  if (view === "line") {
    return (
      <span className="flex items-center gap-1">
        <span className="inline-block h-2 w-2 rounded-full bg-foreground" /> Close
      </span>
    );
  }
  return (
    <>
      <span className="flex items-center gap-1">
        <span className="inline-block h-2 w-2 bg-[var(--profit)]" /> Up
      </span>
      <span className="flex items-center gap-1">
        <span className="inline-block h-2 w-2 bg-[var(--loss)]" /> Down
      </span>
    </>
  );
}

function LevelLegend({
  label,
  color,
  clipped,
  price,
  arrow,
  symbol,
}: {
  label: string;
  color: string;
  clipped: boolean;
  price: number | null;
  arrow: "↑" | "↓";
  symbol: string;
}) {
  return (
    <span className="flex items-center gap-1">
      <span className="inline-block h-0.5 w-3" style={{ backgroundColor: color }} />
      {label}{" "}
      {clipped && price != null ? (
        <span className="font-medium" style={{ color }}>
          {arrow} {formatPriceValue(symbol, price)}
        </span>
      ) : null}
    </span>
  );
}

export function ChartHeader(props: {
  barCount: number;
  timeframe: string;
  view: ChartView;
  onChange: (v: ChartView) => void;
  slClipped: boolean;
  tpClipped: boolean;
  slPrice: number | null;
  tpPrice: number | null;
  symbol: string;
}) {
  return (
    <div className="text-xs text-muted-foreground mb-2 flex flex-wrap items-center gap-x-4 gap-y-1">
      <span>
        {props.barCount} bars · {props.timeframe}
      </span>
      <ViewLegend view={props.view} />
      <LevelLegend
        label="TP"
        color="var(--profit)"
        clipped={props.tpClipped}
        price={props.tpPrice}
        arrow="↑"
        symbol={props.symbol}
      />
      <LevelLegend
        label="SL"
        color="var(--loss)"
        clipped={props.slClipped}
        price={props.slPrice}
        arrow="↓"
        symbol={props.symbol}
      />
      <span className="flex items-center gap-1">
        <span className="inline-block h-0.5 w-3 border-t border-dashed border-foreground" /> Entry
      </span>
      <ViewToggle value={props.view} onChange={props.onChange} />
    </div>
  );
}
