"use client";

import { useEffect, useRef } from "react";
import {
  ColorType,
  createChart,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import type { ChartBar, ChartMarker } from "@/app/(dashboard)/chart/actions";

interface TradingChartProps {
  bars: ChartBar[];
  sma20: (number | null)[];
  markers: ChartMarker[];
  height?: number;
}

/** Resolve a CSS custom property on the container, falling back to a
 *  hardcoded color when the variable is unset or returns an oklch value
 *  lightweight-charts can't parse. Lightweight-charts accepts hex /
 *  rgb / rgba / named colors only. */
function resolveColor(container: HTMLElement, varName: string, fallback: string): string {
  const raw = getComputedStyle(container).getPropertyValue(varName).trim();
  if (!raw) return fallback;
  // lightweight-charts can't parse oklch/lch/hsl-modern — fall back.
  if (/^(oklch|lch|color)/.test(raw)) return fallback;
  return raw;
}

function makeChart(container: HTMLDivElement, height: number): IChartApi {
  // Theme-aware text/grid colors. We can't pass `var(...)` directly to
  // lightweight-charts (it doesn't parse CSS variables), and our oklch
  // tokens don't parse either, so we resolve at mount with explicit
  // theme-neutral fallbacks.
  const textColor = resolveColor(container, "--color-foreground", "rgba(160,160,170,0.95)");
  return createChart(container, {
    width: container.clientWidth,
    height,
    layout: {
      background: { type: ColorType.Solid, color: "transparent" },
      textColor,
      fontSize: 11,
    },
    grid: {
      vertLines: { color: "rgba(120,120,120,0.1)" },
      horzLines: { color: "rgba(120,120,120,0.1)" },
    },
    rightPriceScale: { borderColor: "rgba(120,120,120,0.3)" },
    timeScale: { borderColor: "rgba(120,120,120,0.3)", timeVisible: true, secondsVisible: false },
    crosshair: { mode: 1 },
  });
}

function makeCandleSeries(chart: IChartApi): ISeriesApi<"Candlestick"> {
  return chart.addCandlestickSeries({
    upColor: "rgba(74, 196, 142, 1)",
    downColor: "rgba(232, 90, 90, 1)",
    borderVisible: false,
    wickUpColor: "rgba(74, 196, 142, 1)",
    wickDownColor: "rgba(232, 90, 90, 1)",
  });
}

function makeSmaSeries(chart: IChartApi): ISeriesApi<"Line"> {
  return chart.addLineSeries({
    color: "rgba(120, 180, 230, 0.9)",
    lineWidth: 2,
    lineStyle: LineStyle.Solid,
    priceLineVisible: false,
    lastValueVisible: false,
  });
}

function markerFor(m: ChartMarker): SeriesMarker<Time> {
  if (m.kind === "entry") {
    return {
      time: m.time as UTCTimestamp,
      position: m.side === "long" ? "belowBar" : "aboveBar",
      color: m.side === "long" ? "rgba(74, 196, 142, 1)" : "rgba(232, 90, 90, 1)",
      shape: m.side === "long" ? "arrowUp" : "arrowDown",
      text: m.label,
    };
  }
  const win = (m.r_multiple ?? 0) >= 0;
  return {
    time: m.time as UTCTimestamp,
    position: "inBar",
    color: win ? "rgba(74, 196, 142, 1)" : "rgba(232, 90, 90, 1)",
    shape: win ? "circle" : "square",
    text: m.label,
  };
}

/**
 * Trader-familiar candlestick chart powered by TradingView's
 * lightweight-charts library. Renders OHLC candles + an SMA20 overlay
 * + entry/exit triangle markers from the algorithm's paper trades on
 * this instrument.
 *
 * Per the operator's "live technical analysis with signal indicators
 * shown in a way that traders are used to" — this is the candle +
 * indicators + trade-markers baseline. Future iterations layer FVG
 * zones, regime band, sweep markers via SeriesPrimitive plugins.
 */
export function TradingChart({ bars, sma20, markers, height = 480 }: TradingChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const smaSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);

  // One-shot setup: container, chart instance, series, resize observer.
  // Re-created when height changes (rare).
  useEffect(() => {
    if (!containerRef.current) return;
    const container = containerRef.current;
    const chart = makeChart(container, height);
    chartRef.current = chart;
    candleSeriesRef.current = makeCandleSeries(chart);
    smaSeriesRef.current = makeSmaSeries(chart);

    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        chart.applyOptions({ width: e.contentRect.width });
      }
    });
    ro.observe(container);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      smaSeriesRef.current = null;
    };
  }, [height]);

  // Push bars + SMA + markers when data changes.
  useEffect(() => {
    const candle = candleSeriesRef.current;
    const smaSeries = smaSeriesRef.current;
    const chart = chartRef.current;
    if (!candle || !smaSeries || !chart) return;
    candle.setData(
      bars.map((b) => ({
        time: b.time as UTCTimestamp,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
      }))
    );
    const smaData = bars
      .map((b, i) => {
        const v = sma20[i];
        if (v == null) return null;
        return { time: b.time as UTCTimestamp, value: v };
      })
      .filter((p): p is { time: UTCTimestamp; value: number } => p != null);
    smaSeries.setData(smaData);

    // Markers — entry triangles, exit circle/square based on R sign.
    candle.setMarkers(markers.map(markerFor));

    chart.timeScale().fitContent();
  }, [bars, sma20, markers]);

  return (
    <div
      ref={containerRef}
      className="w-full rounded-md border bg-background/60"
      style={{ height }}
    />
  );
}
