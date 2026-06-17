/**
 * KlineChart overlay + indicator helpers. Split from kline-chart.tsx to
 * stay under max-lines and isolate the klinecharts-specific
 * style/option shaping from the React component.
 */
import { LineType, PolygonType, registerOverlay, type Chart, type OverlayCreate } from "klinecharts";
import type {
  ChartData,
  ChartMarker,
  PatternAnnotation,
} from "@/app/(dashboard)/chart/actions";
import { LAYER_META, type LayerConfig } from "./layer-config";

const PROFIT_COLOR = "rgba(74,196,142,1)";
const LOSS_COLOR = "rgba(232,90,90,1)";
const NEUTRAL_COLOR = "rgba(180,180,220,1)";

/** Custom overlay: flat text at a single point. Built-in
 *  `simpleAnnotation` paints text inside a blue bubble + arrow +
 *  connector line because the global OverlayStyle.text default has
 *  backgroundColor=blue, borderColor=blue. Per-overlay style overrides
 *  pass through that same global text style.
 *
 *  This template draws ONE text figure with per-figure styles set
 *  explicitly to transparent background / no border. The per-figure
 *  styles bypass the global text style entirely.
 *
 *  extendData payload: `{ text: string, color: string }` so each label
 *  carries its own color. */
const TEXT_LABEL_OVERLAY = {
  name: "textLabel",
  totalStep: 2,
  needDefaultPointFigure: false,
  needDefaultXAxisFigure: false,
  needDefaultYAxisFigure: false,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createPointFigures: ({ overlay, coordinates }: any) => {
    const data = overlay.extendData ?? {};
    const text = typeof data.text === "string" ? data.text : "";
    const color = typeof data.color === "string" ? data.color : NEUTRAL_COLOR;
    return [
      {
        type: "text",
        attrs: {
          x: coordinates[0].x,
          y: coordinates[0].y,
          text,
          align: "center",
          baseline: "middle",
        },
        styles: {
          color,
          size: 11,
          family: "system-ui",
          weight: "600",
          backgroundColor: "transparent",
          borderColor: "transparent",
          borderSize: 0,
          paddingLeft: 0,
          paddingRight: 0,
          paddingTop: 0,
          paddingBottom: 0,
        },
        ignoreEvent: true,
      },
    ];
  },
};

let textLabelRegistered = false;
export function ensureTextLabelRegistered(): void {
  if (textLabelRegistered) return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerOverlay(TEXT_LABEL_OVERLAY as any);
  textLabelRegistered = true;
}

function labelOverlay(timestamp: number, value: number, text: string, color: string): OverlayCreate {
  return {
    name: "textLabel",
    points: [{ timestamp, value }],
    extendData: { text, color },
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

function annotationOverlays(a: PatternAnnotation): OverlayCreate[] {
  const color = directionColor(a.direction);
  // klinecharts uses milliseconds; ChartData times are UTC seconds.
  const t1 = a.from_time * 1000;
  const t2 = a.to_time * 1000;

  if (a.kind === "line") {
    return [
      {
        name: "segment",
        points: [
          { timestamp: t1, value: a.top },
          { timestamp: t2, value: a.top },
        ],
        styles: { line: { color, style: LineType.Dashed, size: 2, dashedValue: [4, 4] } },
      },
      labelOverlay((t1 + t2) / 2, a.top, ANNOTATION_LABELS[a.pattern_type], color),
    ];
  }

  const bottom = a.bottom ?? a.top;
  return [
    {
      // v9 calls this overlay "rect" (not "rectangle"). Passing a name
      // klinecharts doesn't know throws "Cannot read properties of
      // undefined (reading '0')" when it tries to look up the figure.
      name: "rect",
      points: [
        { timestamp: t1, value: a.top },
        { timestamp: t2, value: bottom },
      ],
      styles: {
        polygon: {
          style: PolygonType.StrokeFill,
          color: color.replace(",1)", ",0.10)"),
          borderColor: color.replace(",1)", ",0.55)"),
          borderSize: 1,
        },
      },
    },
    labelOverlay((t1 + t2) / 2, (a.top + bottom) / 2, ANNOTATION_LABELS[a.pattern_type], color),
  ];
}

function tradeOverlays(markers: ChartMarker[], layers: LayerConfig): OverlayCreate[] {
  const out: OverlayCreate[] = [];
  for (const m of markers) {
    if (m.kind === "entry" && !layers.trade_entries) continue;
    if (m.kind === "exit" && !layers.trade_exits) continue;
    const color = m.side === "long" ? PROFIT_COLOR : LOSS_COLOR;
    out.push(labelOverlay(m.time * 1000, m.price, m.label, color));
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
    const color = bullish ? PROFIT_COLOR : LOSS_COLOR;
    return labelOverlay(s.time * 1000, s.price, s.type, color);
  });
}

export function applyOverlays(chart: Chart, data: ChartData, layers: LayerConfig): void {
  chart.removeOverlay();
  const overlays: OverlayCreate[] = [];
  for (const a of data.patterns.annotations) {
    if (isAnnotationEnabled(a, layers)) overlays.push(...annotationOverlays(a));
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
 *  match our LAYER_META swatches. Override per indicator so the legend
 *  chip and the chart line agree.
 *
 *  IMPORTANT: must set size + style + smooth + dashedValue explicitly.
 *  When the override is `{ color }` only, klinecharts replaces the
 *  lines array rather than deep-merging missing fields — so the line
 *  ends up at size=0 (invisible) which was why SMA20 wasn't rendering
 *  even though the legend label had the right color. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function lineStyles(color: string, count = 1): any {
  return {
    lines: Array.from({ length: count }, () => ({
      color,
      size: 1,
      style: LineType.Solid,
      smooth: false,
      dashedValue: [2, 2],
    })),
  };
}

export function applyIndicators(chart: Chart, layers: LayerConfig): void {
  clearIndicators(chart);
  const main = { id: MAIN_PANE_ID };
  if (layers.sma20) {
    chart.createIndicator(
      { name: "MA", calcParams: [20], styles: lineStyles(LAYER_META.sma20.color) },
      true,
      main
    );
  }
  if (layers.sma50) {
    chart.createIndicator(
      { name: "MA", calcParams: [50], styles: lineStyles(LAYER_META.sma50.color) },
      true,
      main
    );
  }
  if (layers.sma200) {
    chart.createIndicator(
      { name: "MA", calcParams: [200], styles: lineStyles(LAYER_META.sma200.color) },
      true,
      main
    );
  }
  if (layers.ema12) {
    chart.createIndicator(
      { name: "EMA", calcParams: [12], styles: lineStyles(LAYER_META.ema12.color) },
      true,
      main
    );
  }
  if (layers.ema26) {
    chart.createIndicator(
      { name: "EMA", calcParams: [26], styles: lineStyles(LAYER_META.ema26.color) },
      true,
      main
    );
  }
  if (layers.bollinger) {
    chart.createIndicator(
      { name: "BOLL", styles: lineStyles(LAYER_META.bollinger.color, 3) },
      true,
      main
    );
  }
  if (layers.rsi) {
    chart.createIndicator(
      { name: "RSI", calcParams: [14], styles: lineStyles(LAYER_META.rsi.color) },
      false,
      { id: RSI_PANE_ID }
    );
  }
  if (layers.macd) {
    chart.createIndicator(
      { name: "MACD", styles: lineStyles(LAYER_META.macd.color, 2) },
      false,
      { id: MACD_PANE_ID }
    );
  }
}
