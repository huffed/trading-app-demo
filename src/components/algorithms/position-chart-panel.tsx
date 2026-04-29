"use client";

import { useState } from "react";
import { ResponsiveContainer } from "recharts";
import { Skeleton } from "@/components/ui/skeleton";
import { usePositionChartData } from "@/hooks/use-position-stats";
import type { PaperPosition } from "@/types/position";
import {
  ChartBody,
  ChartHeader,
  type ChartPoint,
  type ChartRenderData,
  type ChartView,
  formatTick,
} from "./position-chart-render";

export function PositionChartPanel({ pos }: { pos: PaperPosition }) {
  const { data, isLoading } = usePositionChartData(pos.id, true);
  const [view, setView] = useState<ChartView>("line");

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
    open: b.open,
    high: b.high,
    low: b.low,
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

  const entryPoint = data.entry_bar_date
    ? points.find((p) => p.date === data.entry_bar_date)
    : null;
  const exitPoint = data.exit_bar_date
    ? points.find((p) => p.date === data.exit_bar_date)
    : null;

  const renderData: ChartRenderData = {
    points,
    yDomain,
    symbol: pos.ticker,
    view,
    entryPrice: data.entry_price,
    slPrice: data.stop_loss_price,
    tpPrice: data.take_profit_price,
    exitPrice: data.exit_price,
    side: data.side,
    entryLabel: entryPoint?.label ?? null,
    exitLabel: exitPoint?.label ?? null,
  };

  return (
    <div className="px-4 py-3">
      <ChartHeader
        barCount={data.bars.length}
        timeframe={data.timeframe}
        view={view}
        onChange={setView}
      />
      <ResponsiveContainer width="100%" height={260}>
        <ChartBody data={renderData} />
      </ResponsiveContainer>
    </div>
  );
}
