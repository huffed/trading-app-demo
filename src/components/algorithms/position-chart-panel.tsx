"use client";

import { useState } from "react";
import { ResponsiveContainer } from "recharts";
import type { PatternViz } from "@/app/(dashboard)/algorithms/pattern-viz-actions";
import type { PositionChartData } from "@/app/(dashboard)/algorithms/position-chart-actions";
import { Skeleton } from "@/components/ui/skeleton";
import {
  usePatternVisualization,
  usePositionChartData,
} from "@/hooks/use-position-stats";
import type { PaperPosition } from "@/types/position";
import {
  ChartBody,
  ChartHeader,
  type ChartPoint,
  type ChartRenderData,
  type ChartView,
  formatTick,
} from "./position-chart-render";

interface DerivedChart {
  points: ChartPoint[];
  yDomain: [number, number];
  slClipped: boolean;
  tpClipped: boolean;
  entryLabel: string | null;
  exitLabel: string | null;
}

function deriveChart(data: PositionChartData): DerivedChart {
  const points: ChartPoint[] = data.bars.map((b) => ({
    date: b.date,
    label: formatTick(b.date, data.timeframe),
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
  }));
  const yValues = [
    ...data.bars.map((b) => b.low),
    ...data.bars.map((b) => b.high),
    data.entry_price,
  ];
  if (data.exit_price != null) yValues.push(data.exit_price);
  const yMin = Math.min(...yValues);
  const yMax = Math.max(...yValues);
  const yPad = (yMax - yMin) * 0.1;
  const yDomain: [number, number] = [yMin - yPad, yMax + yPad];
  const slClipped =
    data.stop_loss_price != null &&
    (data.stop_loss_price < yDomain[0] || data.stop_loss_price > yDomain[1]);
  const tpClipped =
    data.take_profit_price != null &&
    (data.take_profit_price < yDomain[0] || data.take_profit_price > yDomain[1]);
  const entryLabel = data.entry_bar_date
    ? points.find((p) => p.date === data.entry_bar_date)?.label ?? null
    : null;
  const exitLabel = data.exit_bar_date
    ? points.find((p) => p.date === data.exit_bar_date)?.label ?? null
    : null;
  return { points, yDomain, slClipped, tpClipped, entryLabel, exitLabel };
}

function buildRenderData(
  data: PositionChartData,
  derived: DerivedChart,
  view: ChartView,
  symbol: string,
  patternViz: PatternViz | null
): ChartRenderData {
  return {
    points: derived.points,
    yDomain: derived.yDomain,
    symbol,
    view,
    entryPrice: data.entry_price,
    slPrice: derived.slClipped ? null : data.stop_loss_price,
    tpPrice: derived.tpClipped ? null : data.take_profit_price,
    exitPrice: data.exit_price,
    side: data.side,
    entryLabel: derived.entryLabel,
    exitLabel: derived.exitLabel,
    patternViz,
  };
}

export function PositionChartPanel({
  pos,
  selectedConditionIndex,
}: {
  pos: PaperPosition;
  selectedConditionIndex?: number | null;
}) {
  const { data, isLoading } = usePositionChartData(pos.id, true);
  const { data: patternViz } = usePatternVisualization(
    pos.id,
    selectedConditionIndex ?? null
  );
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

  const derived = deriveChart(data);
  const renderData = buildRenderData(data, derived, view, pos.ticker, patternViz ?? null);

  return (
    <div className="px-4 py-3">
      <ChartHeader
        barCount={data.bars.length}
        timeframe={data.timeframe}
        view={view}
        onChange={setView}
        slClipped={derived.slClipped}
        tpClipped={derived.tpClipped}
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
