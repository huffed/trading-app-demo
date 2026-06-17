import type { ChartBar, ChartIndicators } from "@/app/(dashboard)/chart/actions";
import { makeLineSeries, toLineData, type LinePoint } from "./chart-helpers";
import { LAYER_META, type LayerConfig } from "./layer-config";
import type { IChartApi, ISeriesApi } from "lightweight-charts";

export interface OverlaySeriesRefs {
  candle: ISeriesApi<"Candlestick"> | null;
  sma20: ISeriesApi<"Line"> | null;
  sma50: ISeriesApi<"Line"> | null;
  sma200: ISeriesApi<"Line"> | null;
  ema12: ISeriesApi<"Line"> | null;
  ema26: ISeriesApi<"Line"> | null;
  bbUpper: ISeriesApi<"Line"> | null;
  bbMiddle: ISeriesApi<"Line"> | null;
  bbLower: ISeriesApi<"Line"> | null;
}

export function emptyRefs(): OverlaySeriesRefs {
  return {
    candle: null,
    sma20: null,
    sma50: null,
    sma200: null,
    ema12: null,
    ema26: null,
    bbUpper: null,
    bbMiddle: null,
    bbLower: null,
  };
}

type OverlayKey = Exclude<keyof OverlaySeriesRefs, "candle">;

function syncOne(
  chart: IChartApi,
  refs: OverlaySeriesRefs,
  key: OverlayKey,
  enabled: boolean,
  factory: () => ISeriesApi<"Line">,
  data: LinePoint[]
): void {
  if (enabled) {
    if (!refs[key]) {
      refs[key] = factory();
    }
    const series = refs[key] as ISeriesApi<"Line">;
    series.setData(data);
    return;
  }
  if (refs[key]) {
    chart.removeSeries(refs[key] as ISeriesApi<"Line">);
    refs[key] = null;
  }
}

export function syncOverlays(
  chart: IChartApi,
  refs: OverlaySeriesRefs,
  bars: ChartBar[],
  ind: ChartIndicators,
  layers: LayerConfig
): void {
  syncOne(chart, refs, "sma20", layers.sma20, () => makeLineSeries(chart, LAYER_META.sma20.color), toLineData(bars, ind.sma20));
  syncOne(chart, refs, "sma50", layers.sma50, () => makeLineSeries(chart, LAYER_META.sma50.color), toLineData(bars, ind.sma50));
  syncOne(chart, refs, "sma200", layers.sma200, () => makeLineSeries(chart, LAYER_META.sma200.color), toLineData(bars, ind.sma200));
  syncOne(chart, refs, "ema12", layers.ema12, () => makeLineSeries(chart, LAYER_META.ema12.color), toLineData(bars, ind.ema12));
  syncOne(chart, refs, "ema26", layers.ema26, () => makeLineSeries(chart, LAYER_META.ema26.color), toLineData(bars, ind.ema26));
  syncOne(chart, refs, "bbUpper", layers.bollinger, () => makeLineSeries(chart, LAYER_META.bollinger.color, 1), toLineData(bars, ind.bb_upper));
  syncOne(chart, refs, "bbMiddle", layers.bollinger, () => makeLineSeries(chart, LAYER_META.bollinger.color, 1), toLineData(bars, ind.bb_middle));
  syncOne(chart, refs, "bbLower", layers.bollinger, () => makeLineSeries(chart, LAYER_META.bollinger.color, 1), toLineData(bars, ind.bb_lower));
}
