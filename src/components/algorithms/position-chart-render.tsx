"use client";

import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  LineChart,
  ReferenceArea,
  ReferenceDot,
  ReferenceLine,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { PatternViz } from "@/app/(dashboard)/algorithms/pattern-viz-actions";
import { formatShortDate } from "@/lib/utils/date";
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
  /** Pattern overlay to render. Null = no overlay. */
  patternViz?: PatternViz | null;
}

export function formatTick(iso: string, timeframe: string): string {
  if (timeframe === "1d" || timeframe === "1day") {
    // formatShortDate hardcodes en-US (consistent "Apr 28" labels regardless
    // of browser locale — a trading-dashboard property, not a regression
    // from the prior `toLocaleDateString(undefined, ...)`). Intra-day ticks
    // below intentionally use `undefined` (browser locale) since hours/minutes
    // formatting is locale-insensitive in practice.
    return formatShortDate(iso);
  }
  return new Date(iso).toLocaleString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function exitDotColor(data: ChartRenderData): string {
  if (data.exitPrice == null) return "var(--loss)";
  const profitable =
    (data.exitPrice > data.entryPrice && data.side === "long") ||
    (data.exitPrice < data.entryPrice && data.side === "short");
  return profitable ? "var(--profit)" : "var(--loss)";
}

/**
 * Render the pattern-specific overlay (momentum window, daily-bias MA
 * line, etc) on top of the chart. Each pattern kind has its own
 * trader-style geometry. Implemented as a regular component returning
 * Recharts primitives — must be rendered INSIDE the chart so axes
 * and ReferenceArea/ReferenceLine resolve correctly.
 */
function PatternOverlay({ data }: { data: ChartRenderData }) {
  const viz = data.patternViz;
  if (!viz) return null;

  if (viz.kind === "momentum") {
    // Find chart points whose date falls inside the lookback window.
    const start = new Date(viz.start_date).getTime();
    const end = new Date(viz.end_date).getTime();
    const inside = data.points.filter((p) => {
      const t = new Date(p.date).getTime();
      return t >= start && t <= end;
    });
    if (inside.length === 0) return null;
    const first = inside[0].label;
    const last = inside[inside.length - 1].label;
    const fill = viz.direction === "bullish" ? "var(--profit)" : "var(--loss)";
    return (
      <ReferenceArea
        x1={first}
        x2={last}
        fill={fill}
        fillOpacity={0.12}
        stroke={fill}
        strokeOpacity={0.4}
        strokeWidth={1}
        ifOverflow="extendDomain"
        label={{
          value: `${viz.direction} momentum ${viz.signed_size_atr.toFixed(2)} ATR`,
          position: "insideTopLeft",
          fontSize: 10,
          fill,
        }}
      />
    );
  }

  if (viz.kind === "daily_bias") {
    // Find each chart point's nearest preceding daily MA value, then
    // render as a Line in a paired component (here we expose just a
    // ReferenceLine at the latest MA value as a simple anchor; the
    // step-line series is added by ChartBody as a separate <Line />).
    const latest = viz.ma_series.at(-1);
    if (!latest) return null;
    const biasColors: Record<string, string> = {
      bullish: "var(--profit)",
      bearish: "var(--loss)",
      neutral: "var(--color-muted-foreground)",
    };
    const color = biasColors[viz.bias_at_entry] ?? "var(--color-muted-foreground)";
    return (
      <ReferenceLine
        y={latest.value}
        stroke={color}
        strokeWidth={1.5}
        strokeDasharray="2 4"
        label={{
          value: `SMA${viz.ma_period} (${viz.bias_at_entry})`,
          position: "left",
          fontSize: 10,
          fill: color,
        }}
      />
    );
  }

  return null;
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
        <PatternOverlay data={data} />
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
      <PatternOverlay data={data} />
      <ChartReferenceMarkers data={data} />
      <Bar
        dataKey={(d: ChartPoint) => [d.low, d.high]}
        shape={CandleShape}
        isAnimationActive={false}
      />
    </ComposedChart>
  );
}
