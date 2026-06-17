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
import type { ChartData, ChartTimeframe } from "@/app/(dashboard)/chart/actions";
import { applyIndicators, applyOverlays, ensureTextLabelRegistered } from "./kline-overlays";
import { type LayerConfig } from "./layer-config";

// Register the custom text-label overlay once at module load — must
// happen before any chart.createOverlay call references "textLabel".
ensureTextLabelRegistered();

interface KlineChartProps {
  data: ChartData;
  layers: LayerConfig;
  /** Currently displayed timeframe — used to roll the in-progress bar
   *  forward when the live price moves into the next bar's window. */
  timeframe: ChartTimeframe;
  /** Latest OANDA mid-price. Drives the in-progress last bar's close
   *  via chart.updateData so the built-in priceMark.last (the green
   *  dashed line) tracks the live tick. null while loading. */
  livePrice?: number | null;
  /** UTC seconds — when set, the chart scrolls to put this timestamp
   *  near the center of the visible range. Used by /backtest to focus
   *  on a clicked trade. */
  focusTime?: number | null;
  /** Main pane height. Each oscillator pane (RSI, MACD) adds 140px. */
  height?: number;
}

const TEXT_COLOR = "rgba(160,164,175,0.95)";
const GRID_COLOR = "rgba(120,120,120,0.10)";
const PROFIT_COLOR = "rgba(74,196,142,1)";
const LOSS_COLOR = "rgba(232,90,90,1)";
const OSCILLATOR_PANE_HEIGHT = 140;

const TF_SECS: Record<ChartTimeframe, number> = {
  "15min": 15 * 60,
  "30min": 30 * 60,
  "1h": 60 * 60,
  "4h": 4 * 60 * 60,
  "1day": 24 * 60 * 60,
};

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

export function KlineChart({
  data,
  layers,
  timeframe,
  livePrice,
  focusTime,
  height = 480,
}: KlineChartProps) {
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

  useLiveBarUpdate(chartRef, livePrice, data.bars, timeframe);
  useFocusOnTimestamp(chartRef, focusTime, data.bars);

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

/** Push live OANDA ticks into the chart by updating the in-progress
 *  last bar (or appending a new one when we cross a TF boundary). The
 *  built-in priceMark.last (the green dashed line) tracks the bar's
 *  close, so updating it that way both moves the line AND keeps the
 *  candle itself looking accurate. Kept out of the KlineChart body so
 *  the component stays under the max-lines limit. */
function useLiveBarUpdate(
  chartRef: React.RefObject<Chart | null>,
  livePrice: number | null | undefined,
  bars: ChartData["bars"],
  timeframe: ChartTimeframe
): void {
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    if (livePrice == null || !isFinite(livePrice) || bars.length === 0) return;
    const tfSecs = TF_SECS[timeframe];
    const lastBar = bars[bars.length - 1];
    const nextBarStart = lastBar.time + tfSecs;
    const nowSecs = Math.floor(Date.now() / 1000);
    if (nowSecs < nextBarStart) {
      // Still inside last bar's window — update its close and extend
      // high/low if the live tick pushed past them.
      chart.updateData({
        timestamp: lastBar.time * 1000,
        open: lastBar.open,
        high: Math.max(lastBar.high, livePrice),
        low: Math.min(lastBar.low, livePrice),
        close: livePrice,
        volume: lastBar.volume,
      });
      return;
    }
    // We're past the last bar's window — synthesize an in-progress bar
    // at the most recent TF boundary using live as OHLC. Floor `now`
    // down to the bar that contains the last historical bar so we don't
    // skip mid-bar after a long gap (weekend close, etc.).
    const elapsed = Math.floor((nowSecs - lastBar.time) / tfSecs);
    const synthStart = lastBar.time + elapsed * tfSecs;
    chart.updateData({
      timestamp: synthStart * 1000,
      open: lastBar.close,
      high: Math.max(lastBar.close, livePrice),
      low: Math.min(lastBar.close, livePrice),
      close: livePrice,
      volume: 0,
    });
  }, [chartRef, livePrice, bars, timeframe]);
}

/** Scroll the chart so `focusTime` (UTC seconds) sits ~30% from the
 *  right edge. Klinecharts has no direct "center on timestamp" API, so
 *  we set the offset distance from the last bar to (last - focus) bars
 *  worth of pixels. Idempotent — no-op when focusTime is null or out
 *  of range. */
function useFocusOnTimestamp(
  chartRef: React.RefObject<Chart | null>,
  focusTime: number | null | undefined,
  bars: ChartData["bars"]
): void {
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || focusTime == null || bars.length === 0) return;
    const lastBar = bars[bars.length - 1];
    if (focusTime > lastBar.time) {
      chart.setOffsetRightDistance(0);
      return;
    }
    // Find the bar index closest to focusTime.
    let lo = 0;
    let hi = bars.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (bars[mid].time < focusTime) lo = mid + 1;
      else hi = mid;
    }
    const idx = lo;
    const barSpace = (chart.getBarSpace?.() as number | undefined) ?? 8;
    // Put `focusTime` ~30% from the right edge: offsetRightDistance is
    // the gap past the last bar, so to PULL the focus bar toward the
    // right we offset by (lastIdx - focusIdx - ~30% of visible) bars.
    const visibleBars = Math.max(40, Math.floor((containerWidth(chart) * 0.4) / barSpace));
    const targetTrailing = Math.floor(visibleBars * 0.3);
    const offsetBars = bars.length - 1 - idx - targetTrailing;
    const offsetPx = Math.max(0, offsetBars * barSpace);
    chart.setOffsetRightDistance(offsetPx);
  }, [chartRef, focusTime, bars]);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function containerWidth(chart: any): number {
  return chart?.getDom?.()?.clientWidth ?? 800;
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
