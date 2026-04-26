"use client";

import { useEffect, useRef } from "react";
import { ColorType, createChart, CrosshairMode, type IChartApi } from "lightweight-charts";
import type { BacktestTrade, PriceBar } from "@/lib/market-data/types";

interface TradeChartProps {
  prices: PriceBar[];
  trades: BacktestTrade[];
}

function formatMarkers(trades: BacktestTrade[]) {
  const markers: {
    time: string;
    position: "belowBar" | "aboveBar";
    color: string;
    shape: "arrowUp" | "arrowDown";
    text: string;
  }[] = [];

  for (const t of trades) {
    markers.push({
      time: t.entry_date,
      position: "belowBar",
      color: "#22c55e",
      shape: "arrowUp",
      text: `Buy $${t.entry_price.toFixed(2)}`,
    });
    markers.push({
      time: t.exit_date,
      position: "aboveBar",
      color: t.pnl >= 0 ? "#22c55e" : "#ef4444",
      shape: "arrowDown",
      text: `${t.pnl >= 0 ? "+" : ""}$${t.pnl.toFixed(2)}`,
    });
  }

  return markers.sort((a, b) => a.time.localeCompare(b.time));
}

export function TradeChart({ prices, trades }: TradeChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);

  useEffect(() => {
    if (!containerRef.current || prices.length < 2) return;

    const chart = createChart(containerRef.current, {
      height: 300,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "#888888",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: "rgba(128,128,128,0.1)" },
        horzLines: { color: "rgba(128,128,128,0.1)" },
      },
      crosshair: { mode: CrosshairMode.Magnet },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false, timeVisible: false },
    });

    const candleSeries = chart.addCandlestickSeries({
      upColor: "#22c55e",
      downColor: "#ef4444",
      borderUpColor: "#22c55e",
      borderDownColor: "#ef4444",
      wickUpColor: "#22c55e",
      wickDownColor: "#ef4444",
    });

    candleSeries.setData(
      prices.map((p) => ({
        time: p.date,
        open: p.open,
        high: p.high,
        low: p.low,
        close: p.close,
      }))
    );

    const markers = formatMarkers(trades);
    if (markers.length > 0) {
      candleSeries.setMarkers(markers);
    }

    const volumeSeries = chart.addHistogramSeries({
      color: "rgba(128,128,128,0.15)",
      priceFormat: { type: "volume" },
      priceScaleId: "",
    });

    volumeSeries.priceScale().applyOptions({
      scaleMargins: { top: 0.85, bottom: 0 },
    });

    volumeSeries.setData(
      prices.map((p) => ({
        time: p.date,
        value: Number.isFinite(p.volume) ? p.volume : 0,
        color: p.close >= p.open ? "rgba(34,197,94,0.15)" : "rgba(239,68,68,0.15)",
      }))
    );

    chart.timeScale().fitContent();
    chartRef.current = chart;

    const handleResize = () => {
      if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth });
    };
    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
      chart.remove();
      chartRef.current = null;
    };
  }, [prices, trades]);

  if (prices.length < 2) return null;

  return <div ref={containerRef} className="w-full rounded-lg" />;
}
