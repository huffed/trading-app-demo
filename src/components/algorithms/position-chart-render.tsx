"use client";

import {
  Bar,
  CartesianGrid,
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

interface CandleShapeProps {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  payload?: ChartPoint;
}

/**
 * Custom shape for the candle Bar. Recharts groups multiple Bar series
 * side-by-side by default, so we can't use one Bar for the wick + one
 * for the body — they'd render next to each other rather than on the
 * same x. A single Bar with this shape draws both: wick line covering
 * the full low → high range (Bar's own y/height), and an inset body
 * rect mapped from open/close via the local pixel-per-price ratio.
 */
function CandleShape({ x, y, width, height, payload }: CandleShapeProps) {
  if (
    payload == null ||
    x == null ||
    y == null ||
    width == null ||
    height == null
  ) {
    return null;
  }
  const { open, high, low, close } = payload;
  const isBull = close >= open;
  const color = isBull ? "var(--profit)" : "var(--loss)";
  const priceRange = high - low;
  // ppp: pixels-per-price in the bar's local coordinate system.
  const ppp = priceRange > 0 ? height / priceRange : 0;

  const bodyTopPrice = Math.max(open, close);
  const bodyBotPrice = Math.min(open, close);
  // y is the pixel of `high`. Smaller y = higher price (screen coords).
  const bodyTopY = y + (high - bodyTopPrice) * ppp;
  const bodyHeight = Math.max(1, (bodyTopPrice - bodyBotPrice) * ppp);

  const cx = x + width / 2;
  const bodyWidth = Math.max(2, width * 0.7);
  const bodyX = cx - bodyWidth / 2;

  return (
    <g>
      <line x1={cx} y1={y} x2={cx} y2={y + height} stroke={color} strokeWidth={1} />
      <rect x={bodyX} y={bodyTopY} width={bodyWidth} height={bodyHeight} fill={color} />
    </g>
  );
}

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
      <Bar
        dataKey={(d: ChartPoint) => [d.low, d.high]}
        shape={CandleShape}
        isAnimationActive={false}
      />
    </ComposedChart>
  );
}
