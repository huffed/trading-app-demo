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

  // Y-axis domain: zoom to the actual price action (bars + entry +
  // exit). We deliberately DON'T include SL/TP — they're often many
  // ATRs away (3R targets and beyond) and would squash the candles
  // into an unreadable thin band. The reference lines clip naturally
  // when SL/TP fall outside the visible range; FTMO's chart does the
  // same.
  const yValues = [
    ...data.bars.map((b) => b.low),
    ...data.bars.map((b) => b.high),
    data.entry_price,
  ];
  if (data.exit_price != null) yValues.push(data.exit_price);
  const yMin = Math.min(...yValues);
  const yMax = Math.max(...yValues);
  const yPad = Math.max((yMax - yMin) * 0.1, (yMax - yMin) * 0.05);
  const yDomain: [number, number] = [yMin - yPad, yMax + yPad];
  const slClipped = data.stop_loss_price != null && (data.stop_loss_price < yDomain[0] || data.stop_loss_price > yDomain[1]);
  const tpClipped = data.take_profit_price != null && (data.take_profit_price < yDomain[0] || data.take_profit_price > yDomain[1]);

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
    slPrice: slClipped ? null : data.stop_loss_price,
    tpPrice: tpClipped ? null : data.take_profit_price,
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
        slClipped={slClipped}
        tpClipped={tpClipped}
        slPrice={data.stop_loss_price}
        tpPrice={data.take_profit_price}
        symbol={pos.ticker}
      />
      <ResponsiveContainer width="100%" height={260}>
        <ChartBody data={renderData} />
      </ResponsiveContainer>
    </div>
  );
}
