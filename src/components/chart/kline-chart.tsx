"use client";

import { useEffect, useRef } from "react";
import {
  dispose,
  init,
  TooltipShowRule,
  TooltipShowType,
  type Chart,
  type KLineData,
} from "klinecharts";
import type { ChartData } from "@/app/(dashboard)/chart/actions";
import { applyIndicators, applyOverlays, ensureTextLabelRegistered } from "./kline-overlays";
import { type LayerConfig } from "./layer-config";

// Register the custom text-label overlay once at module load — must
// happen before any chart.createOverlay call references "textLabel".
ensureTextLabelRegistered();

interface KlineChartProps {
  data: ChartData;
  layers: LayerConfig;
  /** Main pane height. Each oscillator pane (RSI, MACD) adds 140px. */
  height?: number;
}

const TEXT_COLOR = "rgba(160,164,175,0.95)";
const GRID_COLOR = "rgba(120,120,120,0.10)";
const PROFIT_COLOR = "rgba(74,196,142,1)";
const LOSS_COLOR = "rgba(232,90,90,1)";
const OSCILLATOR_PANE_HEIGHT = 140;

function chartStyles() {
  return {
    grid: {
      horizontal: { color: GRID_COLOR },
      vertical: { color: GRID_COLOR },
    },
    candle: {
      bar: {
        upColor: PROFIT_COLOR,
        downColor: LOSS_COLOR,
        upBorderColor: PROFIT_COLOR,
        downBorderColor: LOSS_COLOR,
        upWickColor: PROFIT_COLOR,
        downWickColor: LOSS_COLOR,
      },
      tooltip: { showRule: TooltipShowRule.FollowCross, showType: TooltipShowType.Rect },
      priceMark: { last: { show: true } },
    },
    xAxis: { axisLine: { color: GRID_COLOR }, tickText: { color: TEXT_COLOR } },
    yAxis: { axisLine: { color: GRID_COLOR }, tickText: { color: TEXT_COLOR } },
    crosshair: {
      horizontal: { line: { color: TEXT_COLOR }, text: { color: "#fff", backgroundColor: TEXT_COLOR } },
      vertical: { line: { color: TEXT_COLOR }, text: { color: "#fff", backgroundColor: TEXT_COLOR } },
    },
  };
}

function toKLine(bars: ChartData["bars"]): KLineData[] {
  return bars.map((b) => ({
    timestamp: b.time * 1000,
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
    volume: b.volume,
  }));
}

export function KlineChart({ data, layers, height = 480 }: KlineChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<Chart | null>(null);

  // One-shot chart setup.
  useEffect(() => {
    if (!containerRef.current) return;
    // Capture container ref before init so cleanup sees the same node.
    const container = containerRef.current;
    const chart = init(container, { styles: chartStyles() });
    if (chart) {
      chartRef.current = chart;
      // Klinecharts pads the right side past the last bar with empty
      // "future space" (default ~50px). Our extend-to-edge zones use
      // the last bar's timestamp as the right corner — but klinecharts
      // maps timestamps near the end of the data range into that
      // future space, so rectangles visually leak past the latest
      // candle. Setting the offset to 0 puts the last bar at the
      // right edge of the chart so the zone naturally stops there.
      chart.setOffsetRightDistance(0);
    }
    return () => {
      dispose(container);
      chartRef.current = null;
    };
  }, []);

  // Bars-only effect — runs only when the bar data itself changes (NOT
  // when layers toggle). `applyNewData` resets the chart's visible-time
  // range, so we don't want it firing every time someone flips a layer
  // checkbox (that's what made panning feel like the chart 'snapped
  // back' on every interaction).
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    chart.applyNewData(toKLine(data.bars));
  }, [data.bars]);

  // Indicators + overlays effect — runs on data OR layers changes, but
  // does NOT touch chart.applyNewData, so the visible range is preserved.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    applyIndicators(chart, layers);
    applyOverlays(chart, data, layers);
  }, [data, layers]);

  // Klinecharts grows the canvas to fit oscillator panes — keep the
  // container at least that tall so the panes don't overflow behind
  // anything below (e.g. the daily-bias badge).
  const totalHeight =
    height +
    (layers.rsi ? OSCILLATOR_PANE_HEIGHT : 0) +
    (layers.macd ? OSCILLATOR_PANE_HEIGHT : 0);

  return (
    <div className="space-y-1.5">
      <div
        ref={containerRef}
        className="w-full rounded-md border bg-background/60"
        style={{ height: totalHeight }}
      />
      {layers.daily_bias && data.patterns.daily_bias && (
        <DailyBiasBadge
          bias={data.patterns.daily_bias.bias}
          ma_period={data.patterns.daily_bias.ma_period}
          ma_value={data.patterns.daily_bias.ma_value}
        />
      )}
    </div>
  );
}

const BIAS_COLOR: Record<"bullish" | "bearish" | "neutral", string> = {
  bullish: "text-[var(--profit)]",
  bearish: "text-[var(--loss)]",
  neutral: "text-muted-foreground",
};

function DailyBiasBadge({
  bias,
  ma_period,
  ma_value,
}: {
  bias: "bullish" | "bearish" | "neutral";
  ma_period: number;
  ma_value: number;
}) {
  return (
    <div className="rounded-md border bg-background/60 px-3 py-1.5 text-xs flex items-center justify-between">
      <span className="text-muted-foreground">Daily bias</span>
      <span className={`font-semibold uppercase tracking-wide ${BIAS_COLOR[bias]}`}>
        {bias}
        <span className="ml-2 text-muted-foreground font-normal normal-case">
          (close vs SMA{ma_period} = {ma_value.toFixed(2)})
        </span>
      </span>
    </div>
  );
}
