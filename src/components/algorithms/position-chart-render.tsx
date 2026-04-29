"use client";

import {
  Bar,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  LineChart,
  ReferenceDot,
  ReferenceLine,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Button } from "@/components/ui/button";
import { formatPriceValue } from "@/lib/utils/pnl";

export interface ChartPoint {
  /** Bar timestamp ISO. */
  date: string;
  /** Display label for x-axis ticks. */
  label: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

export type ChartView = "line" | "candle";

export interface ChartRenderData {
  points: ChartPoint[];
  yDomain: [number, number];
  symbol: string;
  view: ChartView;
  entryPrice: number;
  slPrice: number | null;
  tpPrice: number | null;
  exitPrice: number | null;
  side: "long" | "short";
  entryLabel: string | null;
  exitLabel: string | null;
}

export function formatTick(iso: string, timeframe: string): string {
  const d = new Date(iso);
  if (timeframe === "1d" || timeframe === "1day") {
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  return d.toLocaleString(undefined, { hour: "2-digit", minute: "2-digit" });
}

interface ChartTooltipPayload {
  payload: ChartPoint;
}

function ChartTooltip({
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

function exitDotColor(data: ChartRenderData): string {
  if (data.exitPrice == null) return "var(--loss)";
  const profitable =
    (data.exitPrice > data.entryPrice && data.side === "long") ||
    (data.exitPrice < data.entryPrice && data.side === "short");
  return profitable ? "var(--profit)" : "var(--loss)";
}

function ChartReferenceMarkers({ data }: { data: ChartRenderData }) {
  return (
    <>
      <ReferenceLine
        y={data.entryPrice}
        stroke="var(--color-foreground)"
        strokeDasharray="4 4"
        strokeWidth={1}
        label={{
          value: "Entry",
          position: "right",
          fontSize: 10,
          fill: "var(--color-foreground)",
        }}
      />
      {data.slPrice != null && (
        <ReferenceLine
          y={data.slPrice}
          stroke="var(--loss)"
          strokeWidth={1}
          label={{ value: "SL", position: "right", fontSize: 10, fill: "var(--loss)" }}
        />
      )}
      {data.tpPrice != null && (
        <ReferenceLine
          y={data.tpPrice}
          stroke="var(--profit)"
          strokeWidth={1}
          label={{ value: "TP", position: "right", fontSize: 10, fill: "var(--profit)" }}
        />
      )}
      {data.entryLabel && (
        <ReferenceDot
          x={data.entryLabel}
          y={data.entryPrice}
          r={4}
          fill="var(--color-foreground)"
          stroke="var(--color-background)"
          strokeWidth={2}
        />
      )}
      {data.exitLabel && data.exitPrice != null && (
        <ReferenceDot
          x={data.exitLabel}
          y={data.exitPrice}
          r={4}
          fill={exitDotColor(data)}
          stroke="var(--color-background)"
          strokeWidth={2}
        />
      )}
    </>
  );
}

function ChartAxes({ data }: { data: ChartRenderData }) {
  return (
    <>
      <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
      <XAxis
        dataKey="label"
        tick={{ fontSize: 10, fill: "var(--color-muted-foreground)" }}
        axisLine={false}
        tickLine={false}
        interval="preserveStartEnd"
        minTickGap={30}
      />
      <YAxis
        tick={{ fontSize: 10, fill: "var(--color-muted-foreground)" }}
        axisLine={false}
        tickLine={false}
        domain={data.yDomain}
        tickFormatter={(v) => formatPriceValue(data.symbol, v as number)}
        width={60}
      />
      <Tooltip content={<ChartTooltip symbol={data.symbol} view={data.view} />} />
    </>
  );
}

export function ChartBody({ data }: { data: ChartRenderData }) {
  if (data.view === "line") {
    return (
      <LineChart data={data.points} margin={{ top: 5, right: 10, left: -20, bottom: 0 }}>
        <ChartAxes data={data} />
        <ChartReferenceMarkers data={data} />
        <Line
          type="monotone"
          dataKey="close"
          stroke="var(--color-foreground)"
          strokeWidth={1.5}
          dot={false}
          activeDot={{ r: 3 }}
        />
      </LineChart>
    );
  }
  return (
    <ComposedChart data={data.points} margin={{ top: 5, right: 10, left: -20, bottom: 0 }}>
      <ChartAxes data={data} />
      <ChartReferenceMarkers data={data} />
      <Bar dataKey={(d: ChartPoint) => [d.low, d.high]} barSize={1} isAnimationActive={false}>
        {data.points.map((p, i) => (
          <Cell key={`wick-${i}`} fill={p.close >= p.open ? "var(--profit)" : "var(--loss)"} />
        ))}
      </Bar>
      <Bar
        dataKey={(d: ChartPoint) => [Math.min(d.open, d.close), Math.max(d.open, d.close)]}
        barSize={6}
        isAnimationActive={false}
      >
        {data.points.map((p, i) => (
          <Cell key={`body-${i}`} fill={p.close >= p.open ? "var(--profit)" : "var(--loss)"} />
        ))}
      </Bar>
    </ComposedChart>
  );
}

export function ChartHeader({
  barCount,
  timeframe,
  view,
  onChange,
}: {
  barCount: number;
  timeframe: string;
  view: ChartView;
  onChange: (v: ChartView) => void;
}) {
  return (
    <div className="text-xs text-muted-foreground mb-2 flex flex-wrap items-center gap-x-4 gap-y-1">
      <span>
        {barCount} bars · {timeframe}
      </span>
      {view === "line" && (
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-full bg-foreground" /> Close
        </span>
      )}
      {view === "candle" && (
        <>
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-2 bg-[var(--profit)]" /> Up
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-2 bg-[var(--loss)]" /> Down
          </span>
        </>
      )}
      <span className="flex items-center gap-1">
        <span className="inline-block h-0.5 w-3 bg-[var(--profit)]" /> TP
      </span>
      <span className="flex items-center gap-1">
        <span className="inline-block h-0.5 w-3 bg-[var(--loss)]" /> SL
      </span>
      <span className="flex items-center gap-1">
        <span className="inline-block h-0.5 w-3 border-t border-dashed border-foreground" /> Entry
      </span>
      <ViewToggle value={view} onChange={onChange} />
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
