/**
 * Annotation manager — renders pattern annotations (BOS / sweep /
 * ChoCh lines, FVG / IFVG / OB zones) as miniature LineSeries on the
 * main chart. Each line annotation = 1 series; each zone = 2 series
 * (top + bottom). On layer-toggle or data change the manager creates
 * what's missing and removes what's no longer needed — same idempotent
 * pattern as chart-overlays for indicator lines.
 */
import { LineStyle, type IChartApi, type ISeriesApi, type UTCTimestamp } from "lightweight-charts";
import type { PatternAnnotation } from "@/app/(dashboard)/chart/actions";
import type { LayerConfig } from "./layer-config";

/** Color stops per pattern × direction so the operator can spot the
 *  pattern type from the line color before reading the label. Faint
 *  alpha because zone brackets are background, not foreground. */
const DIRECTION_RGB: Record<"bullish" | "bearish" | "neutral", string> = {
  bullish: "74,196,142",
  bearish: "232,90,90",
  neutral: "180,180,220",
};

function colorFor(annotation: PatternAnnotation): string {
  const base = DIRECTION_RGB[annotation.direction];
  // Zone brackets are quiet background; lines (BOS / sweep / ChoCh) are
  // the trader's primary signal — bumped to near-opaque so the dashes
  // read clearly even on a busy candle area.
  const alpha = annotation.kind === "zone" ? 0.55 : 0.98;
  return `rgba(${base},${alpha})`;
}

interface AnnotationSeries {
  /** Unique key derived from annotation identity for diffing. */
  key: string;
  topSeries: ISeriesApi<"Line">;
  bottomSeries?: ISeriesApi<"Line">;
}

function annotationKey(a: PatternAnnotation): string {
  return [a.pattern_type, a.from_time, a.to_time, a.top.toFixed(5), (a.bottom ?? 0).toFixed(5)].join("|");
}

function makeLine(chart: IChartApi, color: string, dashed: boolean): ISeriesApi<"Line"> {
  return chart.addLineSeries({
    // BOS / sweep / ChoCh dashed lines render thicker than zone brackets
    // so the operator sees them as foreground signals against the
    // candle area.
    color,
    lineWidth: dashed ? 2 : 1,
    lineStyle: dashed ? LineStyle.Dashed : LineStyle.Solid,
    priceLineVisible: false,
    lastValueVisible: false,
    crosshairMarkerVisible: false,
  });
}

function isEnabled(a: PatternAnnotation, layers: LayerConfig): boolean {
  switch (a.pattern_type) {
    case "bos":
      return layers.bos;
    case "choch":
      return layers.choch;
    case "sweep":
      return layers.sweep;
    case "fvg":
      return layers.fvg;
    case "ifvg":
      return layers.ifvg;
    case "order_block":
      return layers.order_block;
  }
}

export interface AnnotationManagerState {
  byKey: Map<string, AnnotationSeries>;
}

export function newAnnotationState(): AnnotationManagerState {
  return { byKey: new Map() };
}

export function syncAnnotations(
  chart: IChartApi,
  state: AnnotationManagerState,
  annotations: PatternAnnotation[],
  layers: LayerConfig
): void {
  const wanted = annotations.filter((a) => isEnabled(a, layers));
  const wantedKeys = new Set(wanted.map(annotationKey));

  // Remove series whose annotation is no longer present / enabled.
  for (const [key, entry] of state.byKey.entries()) {
    if (!wantedKeys.has(key)) {
      chart.removeSeries(entry.topSeries);
      if (entry.bottomSeries) chart.removeSeries(entry.bottomSeries);
      state.byKey.delete(key);
    }
  }

  // Add series for new annotations.
  for (const a of wanted) {
    const key = annotationKey(a);
    if (state.byKey.has(key)) continue;
    const color = colorFor(a);
    // Line annotations (BOS, sweep, ChoCh) get dashed style; zones get solid
    // faint brackets matching the trader-familiar zone rendering.
    const dashed = a.kind === "line";
    const topSeries = makeLine(chart, color, dashed);
    topSeries.setData([
      { time: a.from_time as UTCTimestamp, value: a.top },
      { time: a.to_time as UTCTimestamp, value: a.top },
    ]);
    let bottomSeries: ISeriesApi<"Line"> | undefined;
    if (a.kind === "zone" && a.bottom != null) {
      bottomSeries = makeLine(chart, color, false);
      bottomSeries.setData([
        { time: a.from_time as UTCTimestamp, value: a.bottom },
        { time: a.to_time as UTCTimestamp, value: a.bottom },
      ]);
    }
    // (We used to add a createPriceLine here as a label, but priceLines
    // are full-chart-width by design — they extended each BOS line all
    // the way across the chart. Operator's reference image puts the
    // label at the right end of the line only. For now we rely on the
    // line color (green/red by direction) to convey type, and lean on
    // hover + the planned trade-replay page for the actual labels.)
    state.byKey.set(key, { key, topSeries, bottomSeries });
  }
}

/** Cap annotation density per pattern type — without this, IFVG / FVG
 *  layers render as dozens of overlapping faint lines on a 100-bar chart
 *  and become noise. Keeps the MOST RECENT N events of each kind. */
export function capRecent(
  annotations: PatternAnnotation[],
  perTypeLimit = 8
): PatternAnnotation[] {
  const byType = new Map<PatternAnnotation["pattern_type"], PatternAnnotation[]>();
  for (const a of annotations) {
    const arr = byType.get(a.pattern_type) ?? [];
    arr.push(a);
    byType.set(a.pattern_type, arr);
  }
  const out: PatternAnnotation[] = [];
  for (const [, arr] of byType) {
    arr.sort((a, b) => b.to_time - a.to_time);
    out.push(...arr.slice(0, perTypeLimit));
  }
  return out;
}

export function clearAnnotations(chart: IChartApi, state: AnnotationManagerState): void {
  for (const entry of state.byKey.values()) {
    chart.removeSeries(entry.topSeries);
    if (entry.bottomSeries) chart.removeSeries(entry.bottomSeries);
  }
  state.byKey.clear();
}
