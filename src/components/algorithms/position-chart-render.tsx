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
import { formatPriceValue } from "@/lib/utils/pnl";
import { ChartTooltip } from "./position-chart-controls";

export { ChartHeader } from "./position-chart-controls";

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
        width={75}
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
