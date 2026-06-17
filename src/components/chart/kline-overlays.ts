/**
 * KlineChart overlay + indicator helpers. Split from kline-chart.tsx to
 * stay under max-lines and isolate the klinecharts-specific
 * style/option shaping from the React component.
 */
import { LineType, type Chart, type OverlayCreate } from "klinecharts";
import type {
  ChartBar,
  ChartData,
  ChartMarker,
  PatternAnnotation,
} from "@/app/(dashboard)/chart/actions";
import {
  ensureCustomOverlaysRegistered,
  type LabelAnchor,
} from "./kline-custom-overlays";
import { LAYER_META, type LayerConfig } from "./layer-config";

// Re-export so callers (kline-chart.tsx) can ensure registration.
export { ensureCustomOverlaysRegistered as ensureTextLabelRegistered };

/** Snap an arbitrary UTC-milliseconds timestamp to the closest actual
 *  bar's timestamp. Klinecharts overlay points whose timestamp falls
 *  between bars get snapped to the NEXT-later bar rather than the
 *  closest — for line/zone midpoint labels that meant labels drifted
 *  rightward instead of sitting at the geometric centre. */
function nearestBarMs(targetMs: number, bars: ChartBar[]): number {
  if (bars.length === 0) return targetMs;
  let lo = 0;
  let hi = bars.length - 1;
  // bars are time-ordered ascending; binary search to first bar whose
  // ms-time >= target.
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].time * 1000 < targetMs) lo = mid + 1;
    else hi = mid;
  }
  if (lo === 0) return bars[0].time * 1000;
  const afterMs = bars[lo].time * 1000;
  const beforeMs = bars[lo - 1].time * 1000;
  return targetMs - beforeMs <= afterMs - targetMs ? beforeMs : afterMs;
}

const PROFIT_COLOR = "rgba(74,196,142,1)";
const LOSS_COLOR = "rgba(232,90,90,1)";
const NEUTRAL_COLOR = "rgba(180,180,220,1)";


function labeledSegment(
  t1: number,
  t2: number,
  price: number,
  text: string,
  color: string,
  anchor: "above" | "below"
): OverlayCreate {
  return {
    name: "labeledSegment",
    points: [
      { timestamp: t1, value: price },
      { timestamp: t2, value: price },
    ],
    extendData: { text, color, anchor },
  };
}

function labelOverlay(
  timestamp: number,
  value: number,
  text: string,
  color: string,
  anchor: LabelAnchor = "middle"
): OverlayCreate {
  return {
    name: "textLabel",
    points: [{ timestamp, value }],
    extendData: { text, color, anchor },
  };
}

const ANNOTATION_LABELS: Record<PatternAnnotation["pattern_type"], string> = {
  bos: "BOS",
  choch: "ChoCh",
  sweep: "Sweep",
  fvg: "FVG",
  ifvg: "IFVG",
  order_block: "OB",
};

function directionColor(direction: "bullish" | "bearish" | "neutral"): string {
  if (direction === "bullish") return PROFIT_COLOR;
  if (direction === "bearish") return LOSS_COLOR;
  return NEUTRAL_COLOR;
}

function isAnnotationEnabled(a: PatternAnnotation, layers: LayerConfig): boolean {
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

function annotationOverlays(a: PatternAnnotation, bars: ChartBar[]): OverlayCreate[] {
  const color = directionColor(a.direction);
  // klinecharts uses milliseconds; ChartData times are UTC seconds.
  const t1 = a.from_time * 1000;
  const t2 = a.to_time * 1000;
  // Zone-label midpoint can still use the timestamp-snap approach
  // since rectangle labels sit inside the zone, not on a line. Lines
  // use labeledSegment which computes a true pixel midpoint.
  const tMid = nearestBarMs((t1 + t2) / 2, bars);

  if (a.kind === "line") {
    return [
      labeledSegment(
        t1,
        t2,
        a.top,
        ANNOTATION_LABELS[a.pattern_type],
        color,
        a.direction === "bullish" ? "above" : "below"
      ),
    ];
  }

  const bottom = a.bottom ?? a.top;
  // Zones render as a translucent shaded rectangle via the custom
  // `zoneRect` overlay (no text label — the shape is the annotation).
  // Klinecharts v9 has no built-in rectangle overlay; calling it 'rect'
  // silently no-ops because 'rect' is a low-level figure name, not an
  // overlay name. See kline-custom-overlays.ts ZONE_RECT_OVERLAY.
  void tMid;
  return [
    {
      name: "zoneRect",
      points: [
        { timestamp: t1, value: a.top },
        { timestamp: t2, value: bottom },
      ],
      extendData: { color, fillAlpha: 0.18, borderAlpha: 0.5 },
    },
  ];
}

function tradeOverlays(markers: ChartMarker[], layers: LayerConfig): OverlayCreate[] {
  const out: OverlayCreate[] = [];
  for (const m of markers) {
    if (m.kind === "entry" && !layers.trade_entries) continue;
    if (m.kind === "exit" && !layers.trade_exits) continue;
    const color = m.side === "long" ? PROFIT_COLOR : LOSS_COLOR;
    // Entries get pushed BELOW the entry price (toward the SL); exits
    // ABOVE — so the entry/exit pair don't overlap each other on a
    // round-trip trade. Long entry below the bar reads as 'bought
    // from this level'; short entry below reads similarly.
    const anchor = m.kind === "entry" ? "below" : "above";
    out.push(labelOverlay(m.time * 1000, m.price, m.label, color, anchor));
  }
  return out;
}

function swingOverlays(
  swings: ChartData["patterns"]["swings"],
  enabled: boolean
): OverlayCreate[] {
  if (!enabled) return [];
  return swings.map((s) => {
    const bullish = s.type === "HH" || s.type === "HL";
    const isHigh = s.type === "HH" || s.type === "LH";
    const color = bullish ? PROFIT_COLOR : LOSS_COLOR;
    // Highs labeled above the swing, lows below — matches the
    // trader-image reference (HH labels above the candle high, HL
    // labels below the candle low).
    return labelOverlay(s.time * 1000, s.price, s.type, color, isHigh ? "above" : "below");
  });
}

export function applyOverlays(chart: Chart, data: ChartData, layers: LayerConfig): void {
  chart.removeOverlay();
  const overlays: OverlayCreate[] = [];
  for (const a of data.patterns.annotations) {
    if (isAnnotationEnabled(a, layers)) overlays.push(...annotationOverlays(a, data.bars));
  }
  overlays.push(...swingOverlays(data.patterns.swings, layers.swings));
  overlays.push(...tradeOverlays(data.markers, layers));
  if (overlays.length > 0) chart.createOverlay(overlays);
}

// ───────────────── indicators ─────────────────

export const MAIN_PANE_ID = "candle_pane";
export const RSI_PANE_ID = "rsi_pane";
export const MACD_PANE_ID = "macd_pane";

function clearIndicators(chart: Chart): void {
  chart.removeIndicator(MAIN_PANE_ID);
  chart.removeIndicator(RSI_PANE_ID);
  chart.removeIndicator(MACD_PANE_ID);
}

/** Klinecharts indicators ship with default line colors that don't
 *  match our LAYER_META swatches. Override per line so the legend chip
 *  and the chart line agree.
 *
 *  IMPORTANT: must set size + style + smooth + dashedValue explicitly.
 *  When the override is `{ color }` only, klinecharts replaces the
 *  lines array rather than deep-merging missing fields — so the line
 *  ends up at size=0 (invisible) which was why SMA20 wasn't rendering
 *  even though the legend label had the right color. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function lineStyles(colors: string[]): any {
  return {
    lines: colors.map((color) => ({
      color,
      size: 1,
      style: LineType.Solid,
      smooth: false,
      dashedValue: [2, 2],
    })),
  };
}

/** Klinecharts treats the indicator NAME as the identity within a pane.
 *  Calling createIndicator twice with name='MA' replaces the first one
 *  instead of stacking — only the last call survives. To render multiple
 *  MA periods (or multiple EMA periods) at once we MUST combine them
 *  into a single createIndicator call with multiple calcParams and a
 *  matching lines-styles array. */
export function applyIndicators(chart: Chart, layers: LayerConfig): void {
  clearIndicators(chart);
  const main = { id: MAIN_PANE_ID };

  const maPeriods: number[] = [];
  const maColors: string[] = [];
  if (layers.sma20) {
    maPeriods.push(20);
    maColors.push(LAYER_META.sma20.color);
  }
  if (layers.sma50) {
    maPeriods.push(50);
    maColors.push(LAYER_META.sma50.color);
  }
  if (layers.sma200) {
    maPeriods.push(200);
    maColors.push(LAYER_META.sma200.color);
  }
  if (maPeriods.length > 0) {
    chart.createIndicator(
      { name: "MA", calcParams: maPeriods, styles: lineStyles(maColors) },
      true,
      main
    );
  }

  const emaPeriods: number[] = [];
  const emaColors: string[] = [];
  if (layers.ema12) {
    emaPeriods.push(12);
    emaColors.push(LAYER_META.ema12.color);
  }
  if (layers.ema26) {
    emaPeriods.push(26);
    emaColors.push(LAYER_META.ema26.color);
  }
  if (emaPeriods.length > 0) {
    chart.createIndicator(
      { name: "EMA", calcParams: emaPeriods, styles: lineStyles(emaColors) },
      true,
      main
    );
  }

  if (layers.bollinger) {
    const c = LAYER_META.bollinger.color;
    chart.createIndicator(
      { name: "BOLL", styles: lineStyles([c, c, c]) },
      true,
      main
    );
  }
  if (layers.rsi) {
    chart.createIndicator(
      { name: "RSI", calcParams: [14], styles: lineStyles([LAYER_META.rsi.color]) },
      false,
      { id: RSI_PANE_ID }
    );
  }
  if (layers.macd) {
    const c = LAYER_META.macd.color;
    chart.createIndicator(
      { name: "MACD", styles: lineStyles([c, c]) },
      false,
      { id: MACD_PANE_ID }
    );
  }
}
