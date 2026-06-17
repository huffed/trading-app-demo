"use client";

import { useEffect, useRef } from "react";
import {
  ColorType,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type Range,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import type { ChartData } from "@/app/(dashboard)/chart/actions";
import {
  BORDER_COLOR,
  collectMarkers,
  GRID_COLOR,
  LOSS_COLOR,
  makeHistogramSeries,
  makeLineSeries,
  PROFIT_COLOR,
  TEXT_COLOR,
  toLineData,
} from "./chart-helpers";
import { emptyRefs, syncOverlays, type OverlaySeriesRefs } from "./chart-overlays";
import { LAYER_META, type LayerConfig } from "./layer-config";

interface TradingChartProps {
  data: ChartData;
  layers: LayerConfig;
  /** Main candle pane height. Oscillator panes render at fixed 140px each. */
  height?: number;
}

function makeChart(container: HTMLDivElement, height: number): IChartApi {
  return createChart(container, {
    width: container.clientWidth,
    height,
    layout: {
      background: { type: ColorType.Solid, color: "transparent" },
      textColor: TEXT_COLOR,
      fontSize: 11,
    },
    grid: {
      vertLines: { color: GRID_COLOR },
      horzLines: { color: GRID_COLOR },
    },
    rightPriceScale: { borderColor: BORDER_COLOR },
    timeScale: { borderColor: BORDER_COLOR, timeVisible: true, secondsVisible: false },
    crosshair: { mode: 1 },
  });
}

function makeCandleSeries(chart: IChartApi): ISeriesApi<"Candlestick"> {
  return chart.addCandlestickSeries({
    upColor: PROFIT_COLOR,
    downColor: LOSS_COLOR,
    borderVisible: false,
    wickUpColor: PROFIT_COLOR,
    wickDownColor: LOSS_COLOR,
  });
}

/** Bind a chart instance to its container with a ResizeObserver that
 *  keeps the chart width in sync with the container width. Returns a
 *  teardown function the caller invokes in useEffect cleanup. */
function bindResizeObserver(chart: IChartApi, container: HTMLDivElement): () => void {
  const ro = new ResizeObserver((entries) => {
    for (const e of entries) chart.applyOptions({ width: e.contentRect.width });
  });
  ro.observe(container);
  return () => ro.disconnect();
}

interface MainChartRefs {
  chart: IChartApi;
  overlays: OverlaySeriesRefs;
}

function useMainChart(containerRef: React.RefObject<HTMLDivElement | null>, height: number) {
  const ref = useRef<MainChartRefs | null>(null);
  useEffect(() => {
    if (!containerRef.current) return;
    const chart = makeChart(containerRef.current, height);
    const overlays = emptyRefs();
    overlays.candle = makeCandleSeries(chart);
    ref.current = { chart, overlays };
    const cleanup = bindResizeObserver(chart, containerRef.current);
    return () => {
      cleanup();
      chart.remove();
      ref.current = null;
    };
  }, [containerRef, height]);
  return ref;
}

interface OscillatorRefs {
  chart: IChartApi;
  series: ISeriesApi<"Line">[];
  histogram?: ISeriesApi<"Histogram">;
}

function useRsiPane(
  containerRef: React.RefObject<HTMLDivElement | null>,
  enabled: boolean
) {
  const ref = useRef<OscillatorRefs | null>(null);
  useEffect(() => {
    if (!enabled || !containerRef.current) return;
    const chart = makeChart(containerRef.current, 140);
    chart.timeScale().applyOptions({ visible: false });
    const series = makeLineSeries(chart, LAYER_META.rsi.color, 2);
    ref.current = { chart, series: [series] };
    const cleanup = bindResizeObserver(chart, containerRef.current);
    return () => {
      cleanup();
      chart.remove();
      ref.current = null;
    };
  }, [containerRef, enabled]);
  return ref;
}

function useMacdData(
  ref: React.RefObject<OscillatorRefs | null>,
  data: ChartData,
  enabled: boolean
): void {
  useEffect(() => {
    const p = ref.current;
    if (!p || !p.histogram) return;
    p.series[0].setData(toLineData(data.bars, data.indicators.macd_line));
    p.series[1].setData(toLineData(data.bars, data.indicators.macd_signal));
    p.histogram.setData(
      data.bars
        .map((b, i) => {
          const v = data.indicators.macd_histogram[i];
          if (v == null) return null;
          return {
            time: b.time as UTCTimestamp,
            value: v,
            color: v >= 0 ? "rgba(74,196,142,0.6)" : "rgba(232,90,90,0.6)",
          };
        })
        .filter((p2): p2 is { time: UTCTimestamp; value: number; color: string } => p2 != null)
    );
    p.chart.timeScale().fitContent();
  }, [ref, data, enabled]);
}

function useMacdPane(
  containerRef: React.RefObject<HTMLDivElement | null>,
  enabled: boolean
) {
  const ref = useRef<OscillatorRefs | null>(null);
  useEffect(() => {
    if (!enabled || !containerRef.current) return;
    const chart = makeChart(containerRef.current, 140);
    chart.timeScale().applyOptions({ visible: false });
    const histogram = makeHistogramSeries(chart, "rgba(120,180,230,0.6)");
    const line = makeLineSeries(chart, LAYER_META.macd.color, 2);
    const signal = makeLineSeries(chart, "rgba(232,90,90,0.95)", 1);
    ref.current = { chart, series: [line, signal], histogram };
    const cleanup = bindResizeObserver(chart, containerRef.current);
    return () => {
      cleanup();
      chart.remove();
      ref.current = null;
    };
  }, [containerRef, enabled]);
  return ref;
}

export function TradingChart({ data, layers, height = 480 }: TradingChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const rsiRef = useRef<HTMLDivElement>(null);
  const macdRef = useRef<HTMLDivElement>(null);

  const mainRef = useMainChart(containerRef, height);
  const rsiPaneRef = useRsiPane(rsiRef, layers.rsi);
  const macdPaneRef = useMacdPane(macdRef, layers.macd);

  // Push main chart data + overlays + markers whenever inputs change.
  useEffect(() => {
    const m = mainRef.current;
    if (!m || !m.overlays.candle) return;
    m.overlays.candle.setData(
      data.bars.map((b) => ({
        time: b.time as UTCTimestamp,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
      }))
    );
    syncOverlays(m.chart, m.overlays, data.bars, data.indicators, layers);
    m.overlays.candle.setMarkers(collectMarkers(data.patterns, data.markers, layers));
    m.chart.timeScale().fitContent();
  }, [mainRef, data, layers]);

  // Push RSI data when mounted.
  useEffect(() => {
    const p = rsiPaneRef.current;
    if (!p) return;
    p.series[0].setData(toLineData(data.bars, data.indicators.rsi));
    p.chart.timeScale().fitContent();
  }, [rsiPaneRef, data, layers.rsi]);

  // Push MACD data when mounted.
  useMacdData(macdPaneRef, data, layers.macd);

  // Sync visible time range across main + RSI + MACD when main changes.
  useEffect(() => {
    const m = mainRef.current;
    if (!m) return;
    const handler = (range: Range<Time> | null) => {
      if (!range) return;
      rsiPaneRef.current?.chart.timeScale().setVisibleRange(range);
      macdPaneRef.current?.chart.timeScale().setVisibleRange(range);
    };
    m.chart.timeScale().subscribeVisibleTimeRangeChange(handler);
    return () => {
      m.chart.timeScale().unsubscribeVisibleTimeRangeChange(handler);
    };
  }, [mainRef, rsiPaneRef, macdPaneRef]);

  return (
    <div className="space-y-1.5">
      <div
        ref={containerRef}
        className="w-full rounded-md border bg-background/60"
        style={{ height }}
      />
      {layers.rsi && (
        <PaneFrame label="RSI (14)">
          <div ref={rsiRef} className="w-full" style={{ height: 140 }} />
        </PaneFrame>
      )}
      {layers.macd && (
        <PaneFrame label="MACD (12,26,9)">
          <div ref={macdRef} className="w-full" style={{ height: 140 }} />
        </PaneFrame>
      )}
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

function PaneFrame({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="relative rounded-md border bg-background/60">
      <span className="absolute top-1.5 left-2 z-10 text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      {children}
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
