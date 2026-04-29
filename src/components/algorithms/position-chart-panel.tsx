"use client";

import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Skeleton } from "@/components/ui/skeleton";
import { usePositionChartData } from "@/hooks/use-position-stats";
import { formatPriceValue } from "@/lib/utils/pnl";
import type { PaperPosition } from "@/types/position";

interface ChartPoint {
  /** Bar timestamp ISO. */
  date: string;
  /** Display label for x-axis ticks. */
  label: string;
  close: number;
}

function formatTick(iso: string, timeframe: string): string {
  const d = new Date(iso);
  // Daily bars get a date label; intraday bars get HH:MM with a date
  // prefix when crossing midnight isn't visually obvious.
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
}: {
  active?: boolean;
  payload?: ChartTooltipPayload[];
  symbol: string;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const p = payload[0].payload;
  return (
    <div className="rounded-md border bg-background px-2 py-1.5 text-xs shadow-sm">
      <div className="text-muted-foreground tabular-nums">
        {new Date(p.date).toLocaleString(undefined, {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        })}
      </div>
      <div className="font-medium tabular-nums">{formatPriceValue(symbol, p.close)}</div>
    </div>
  );
}

export function PositionChartPanel({ pos }: { pos: PaperPosition }) {
  const { data, isLoading } = usePositionChartData(pos.id, true);

  if (isLoading && !data) {
    return (
      <div className="px-4 py-3">
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }
  if (!data || data.bars.length < 3) {
    return (
      <p className="px-4 py-3 text-sm text-muted-foreground">
        Not enough cached bars to render a chart yet. Bars accumulate on each scan tick at the
        algorithm&apos;s timeframe.
      </p>
    );
  }

  const points: ChartPoint[] = data.bars.map((b) => ({
    date: b.date,
    label: formatTick(b.date, data.timeframe),
    close: b.close,
  }));

  // Y-axis domain: include all bar lows/highs AND the SL/TP levels so
  // the reference lines don't fall outside the chart.
  const yValues = [
    ...data.bars.map((b) => b.low),
    ...data.bars.map((b) => b.high),
    data.entry_price,
  ];
  if (data.stop_loss_price != null) yValues.push(data.stop_loss_price);
  if (data.take_profit_price != null) yValues.push(data.take_profit_price);
  if (data.exit_price != null) yValues.push(data.exit_price);
  const yMin = Math.min(...yValues);
  const yMax = Math.max(...yValues);
  const yPad = (yMax - yMin) * 0.05;
  const yDomain: [number, number] = [yMin - yPad, yMax + yPad];

  // Find the chart point with date >= entry/exit bar to anchor reference lines.
  const entryPoint = data.entry_bar_date
    ? points.find((p) => p.date === data.entry_bar_date)
    : null;
  const exitPoint = data.exit_bar_date
    ? points.find((p) => p.date === data.exit_bar_date)
    : null;

  return (
    <div className="px-4 py-3">
      <div className="text-xs text-muted-foreground mb-2 flex flex-wrap items-center gap-x-4 gap-y-1">
        <span>
          {data.bars.length} bars · {data.timeframe}
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-full bg-foreground" /> Close
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-0.5 w-3 bg-[var(--profit)]" /> TP
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-0.5 w-3 bg-[var(--loss)]" /> SL
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-0.5 w-3 border-t border-dashed border-foreground" />{" "}
          Entry
        </span>
      </div>
      <ResponsiveContainer width="100%" height={260}>
        <LineChart data={points} margin={{ top: 5, right: 10, left: -20, bottom: 0 }}>
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
            domain={yDomain}
            tickFormatter={(v) => formatPriceValue(pos.ticker, v as number)}
            width={60}
          />
          <Tooltip content={<ChartTooltip symbol={pos.ticker} />} />

          <ReferenceLine
            y={data.entry_price}
            stroke="var(--color-foreground)"
            strokeDasharray="4 4"
            strokeWidth={1}
            label={{ value: "Entry", position: "right", fontSize: 10, fill: "var(--color-foreground)" }}
          />
          {data.stop_loss_price != null && (
            <ReferenceLine
              y={data.stop_loss_price}
              stroke="var(--loss)"
              strokeWidth={1}
              label={{ value: "SL", position: "right", fontSize: 10, fill: "var(--loss)" }}
            />
          )}
          {data.take_profit_price != null && (
            <ReferenceLine
              y={data.take_profit_price}
              stroke="var(--profit)"
              strokeWidth={1}
              label={{ value: "TP", position: "right", fontSize: 10, fill: "var(--profit)" }}
            />
          )}

          {entryPoint && (
            <ReferenceDot
              x={entryPoint.label}
              y={data.entry_price}
              r={4}
              fill="var(--color-foreground)"
              stroke="var(--color-background)"
              strokeWidth={2}
            />
          )}
          {exitPoint && data.exit_price != null && (
            <ReferenceDot
              x={exitPoint.label}
              y={data.exit_price}
              r={4}
              fill={
                data.exit_price > data.entry_price && data.side === "long"
                  ? "var(--profit)"
                  : data.exit_price < data.entry_price && data.side === "short"
                    ? "var(--profit)"
                    : "var(--loss)"
              }
              stroke="var(--color-background)"
              strokeWidth={2}
            />
          )}

          <Line
            type="monotone"
            dataKey="close"
            stroke="var(--color-foreground)"
            strokeWidth={1.5}
            dot={false}
            activeDot={{ r: 3 }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
