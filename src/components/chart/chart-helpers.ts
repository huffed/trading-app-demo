import { LineStyle, type IChartApi, type ISeriesApi, type SeriesMarker, type Time, type UTCTimestamp } from "lightweight-charts";
import type {
  ChartBar,
  ChartMarker,
  ChartPatterns,
  PatternAnnotation,
  SwingMarker,
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

function swingMarker(s: SwingMarker): SeriesMarker<Time> {
  // HH and HL are higher-than-prior structure (uptrend signals); LH and
  // LL are lower-than-prior (downtrend signals). Color matches.
  const bullish = s.type === "HH" || s.type === "HL";
  const isHigh = s.type === "HH" || s.type === "LH";
  return {
    time: s.time as UTCTimestamp,
    position: isHigh ? "aboveBar" : "belowBar",
    color: bullish ? PROFIT_COLOR : LOSS_COLOR,
    shape: "circle",
    text: s.type,
  };
}

function isLineAnnotationEnabled(a: PatternAnnotation, layers: LayerConfig): boolean {
  if (a.kind !== "line") return false;
  if (a.pattern_type === "bos") return layers.bos;
  if (a.pattern_type === "choch") return layers.choch;
  if (a.pattern_type === "sweep") return layers.sweep;
  return false;
}

const ANNOTATION_LABELS: Record<PatternAnnotation["pattern_type"], string> = {
  bos: "BOS",
  choch: "ChoCh",
  sweep: "Sweep",
  fvg: "FVG",
  ifvg: "IFVG",
  order_block: "OB",
};

/** Snap an arbitrary UTC-seconds timestamp to the nearest actual bar
 *  in the series. Lightweight-charts SeriesMarkers only render at
 *  times that match a bar — without this, a midpoint between two
 *  bars silently snaps to the next-later bar, which pushes every
 *  label to the end of its line. */
function nearestBarTime(time: number, bars: ChartBar[]): number {
  if (bars.length === 0) return time;
  // Binary search — bars are time-ordered.
  let lo = 0;
  let hi = bars.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].time < time) lo = mid + 1;
    else hi = mid;
  }
  // lo is the first bar whose time >= target; check lo and lo-1.
  if (lo === 0) return bars[0].time;
  const after = bars[lo].time;
  const before = bars[lo - 1].time;
  return time - before <= after - time ? before : after;
}

/** Build a text-only label marker for the annotation, anchored at the
 *  midpoint of the annotation's time span (snapped to the nearest
 *  actual bar so lightweight-charts can render it).
 *
 *  Lightweight-charts marker `position` is bar-relative ('aboveBar' /
 *  'belowBar' / 'inBar'), NOT line-relative — so vertical positioning
 *  follows the candle at the midpoint bar, not the dashed line itself.
 *  Bullish labels render above the candle (typically reads as "above
 *  the line"); bearish labels render below the candle (may sit above
 *  the line on retest bars where candle.low > broken swing low).
 *
 *  size: 0 hides the marker shape while keeping the text visible. */
function annotationLabelMarker(a: PatternAnnotation, bars: ChartBar[]): SeriesMarker<Time> {
  const isBullish = a.direction === "bullish";
  const midTime = Math.floor((a.from_time + a.to_time) / 2);
  const time = nearestBarTime(midTime, bars);
  return {
    time: time as UTCTimestamp,
    position: isBullish ? "aboveBar" : "belowBar",
    color: isBullish ? PROFIT_COLOR : LOSS_COLOR,
    shape: "circle",
    size: 0,
    text: ANNOTATION_LABELS[a.pattern_type],
  };
}

/** Build the marker list for the main candle series. Renders:
 *    - text labels at break/sweep bars for BOS / ChoCh / Sweep
 *      annotations (snapped to the nearest actual bar so the label
 *      lands where we want it; otherwise lightweight-charts silently
 *      shifts off-bar marker times to the next-later bar)
 *    - swing structure labels (HH / HL / LH / LL) if layers.swings
 *    - trade entry / exit shapes if their respective layers are on
 *  Sort by time per lightweight-charts requirement. */
export function collectMarkers(
  bars: ChartBar[],
  patterns: ChartPatterns,
  trades: ChartMarker[],
  layers: LayerConfig
): SeriesMarker<Time>[] {
  const out: SeriesMarker<Time>[] = [];
  for (const a of patterns.annotations) {
    if (isLineAnnotationEnabled(a, layers)) out.push(annotationLabelMarker(a, bars));
  }
  if (layers.swings) {
    for (const s of patterns.swings) out.push(swingMarker(s));
  }
  for (const t of trades) {
    if (t.kind === "entry" && !layers.trade_entries) continue;
    if (t.kind === "exit" && !layers.trade_exits) continue;
    out.push(tradeMarker(t));
  }
  out.sort((a, b) => (a.time as number) - (b.time as number));
  return out;
}
