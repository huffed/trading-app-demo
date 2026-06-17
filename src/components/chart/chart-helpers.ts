import { LineStyle, type IChartApi, type ISeriesApi, type SeriesMarker, type Time, type UTCTimestamp } from "lightweight-charts";
import type {
  ChartBar,
  ChartMarker,
  ChartPatterns,
  PatternPoint,
} from "@/app/(dashboard)/chart/actions";
import type { LayerConfig } from "./layer-config";

/** Lightweight-charts only accepts hex/rgb/rgba/named colors. Hardcoded
 *  theme-neutral grays — browsers normalize CSS variables to different
 *  color spaces (oklch / lab / lch) that the library can't parse. */
export const TEXT_COLOR = "rgba(160,164,175,0.95)";
export const GRID_COLOR = "rgba(120,120,120,0.10)";
export const BORDER_COLOR = "rgba(120,120,120,0.30)";
export const PROFIT_COLOR = "rgba(74,196,142,1)";
export const LOSS_COLOR = "rgba(232,90,90,1)";
export const NEUTRAL_COLOR = "rgba(180,180,220,0.85)";

export interface LinePoint {
  time: UTCTimestamp;
  value: number;
}

export function toLineData(bars: ChartBar[], values: (number | null)[]): LinePoint[] {
  const out: LinePoint[] = [];
  for (let i = 0; i < bars.length; i++) {
    const v = values[i];
    if (v == null) continue;
    out.push({ time: bars[i].time as UTCTimestamp, value: v });
  }
  return out;
}

export function makeLineSeries(
  chart: IChartApi,
  color: string,
  lineWidth = 2
): ISeriesApi<"Line"> {
  return chart.addLineSeries({
    color,
    lineWidth: lineWidth as 1 | 2 | 3 | 4,
    lineStyle: LineStyle.Solid,
    priceLineVisible: false,
    lastValueVisible: false,
  });
}

export function makeHistogramSeries(chart: IChartApi, color: string): ISeriesApi<"Histogram"> {
  return chart.addHistogramSeries({
    color,
    priceLineVisible: false,
    lastValueVisible: false,
  });
}

function directionColor(direction: "bullish" | "bearish" | "neutral"): string {
  if (direction === "bullish") return PROFIT_COLOR;
  if (direction === "bearish") return LOSS_COLOR;
  return NEUTRAL_COLOR;
}

function tradeMarker(m: ChartMarker): SeriesMarker<Time> {
  if (m.kind === "entry") {
    return {
      time: m.time as UTCTimestamp,
      position: m.side === "long" ? "belowBar" : "aboveBar",
      color: m.side === "long" ? PROFIT_COLOR : LOSS_COLOR,
      shape: m.side === "long" ? "arrowUp" : "arrowDown",
      text: m.label,
    };
  }
  const win = (m.r_multiple ?? 0) >= 0;
  return {
    time: m.time as UTCTimestamp,
    position: "inBar",
    color: win ? PROFIT_COLOR : LOSS_COLOR,
    shape: win ? "circle" : "square",
    text: m.label,
  };
}

function patternMarker(
  pp: PatternPoint,
  shape: SeriesMarker<Time>["shape"],
  prefix: string,
  positionAbove: boolean
): SeriesMarker<Time> {
  return {
    time: pp.time as UTCTimestamp,
    position: positionAbove ? "aboveBar" : "belowBar",
    color: directionColor(pp.direction),
    shape,
    text: `${prefix}${pp.label.slice(0, 30)}`,
  };
}

function pushPattern(
  out: SeriesMarker<Time>[],
  enabled: boolean,
  points: PatternPoint[],
  shape: SeriesMarker<Time>["shape"],
  prefix: string,
  positionAboveBullish = true
): void {
  if (!enabled) return;
  for (const p of points) {
    out.push(patternMarker(p, shape, prefix, positionAboveBullish && p.direction === "bullish"));
  }
}

export function collectMarkers(
  patterns: ChartPatterns,
  trades: ChartMarker[],
  layers: LayerConfig
): SeriesMarker<Time>[] {
  const out: SeriesMarker<Time>[] = [];
  pushPattern(out, layers.fvg, patterns.fvg, "square", "FVG ");
  pushPattern(out, layers.ifvg, patterns.ifvg, "square", "IFVG ");
  pushPattern(out, layers.bos, patterns.bos, "arrowUp", "BOS ");
  pushPattern(out, layers.sweep, patterns.sweep, "circle", "Sweep ", false);
  pushPattern(out, layers.order_block, patterns.order_block, "square", "OB ");
  pushPattern(out, layers.choch, patterns.choch, "arrowDown", "ChoCh ");
  for (const t of trades) {
    if (t.kind === "entry" && !layers.trade_entries) continue;
    if (t.kind === "exit" && !layers.trade_exits) continue;
    out.push(tradeMarker(t));
  }
  out.sort((a, b) => (a.time as number) - (b.time as number));
  return out;
}
