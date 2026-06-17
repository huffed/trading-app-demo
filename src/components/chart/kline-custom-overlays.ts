/**
 * Custom klinecharts overlay templates. Split from kline-overlays.ts
 * to stay under max-lines.
 *
 * Three templates registered:
 *
 *   textLabel — flat text at a single point. The default
 *     `simpleAnnotation` paints text inside a blue bubble + connector
 *     because the global OverlayStyle.text default has backgroundColor
 *     and borderColor set. Per-overlay style overrides pass through
 *     that global style. This template draws ONE text figure with
 *     per-figure styles set explicitly to transparent background / no
 *     border. Per-figure styles bypass the global text style entirely.
 *     extendData: { text, color, anchor: 'above' | 'below' | 'middle' }
 *
 *   labeledSegment — dashed line + centered text label as ONE overlay.
 *     Used by BOS / ChoCh / Sweep so the label sits at the PIXEL
 *     midpoint between the line's endpoints, regardless of bar
 *     alignment. Two separate overlays (segment + textLabel) can't
 *     achieve this because klinecharts snaps overlay points to actual
 *     bar timestamps — a midpoint that falls between bars rounds to
 *     one side or the other.
 *     extendData: { text, color, anchor: 'above' | 'below' }
 */
import { LineType, PolygonType, registerOverlay } from "klinecharts";

const NEUTRAL_COLOR = "rgba(180,180,220,1)";

export type LabelAnchor = "above" | "below" | "middle";

const LABEL_Y_OFFSET = 12; // px

const LABEL_STYLES = {
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
};

const TEXT_LABEL_OVERLAY = {
  name: "textLabel",
  totalStep: 2,
  needDefaultPointFigure: false,
  needDefaultXAxisFigure: false,
  needDefaultYAxisFigure: false,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createPointFigures: ({ overlay, coordinates }: any) => {
    if (!coordinates || coordinates.length === 0) return [];
    const data = overlay.extendData ?? {};
    const text = typeof data.text === "string" ? data.text : "";
    const color = typeof data.color === "string" ? data.color : NEUTRAL_COLOR;
    const anchor: LabelAnchor = data.anchor ?? "middle";
    const DY: Record<LabelAnchor, number> = { above: -LABEL_Y_OFFSET, below: LABEL_Y_OFFSET, middle: 0 };
    const BASELINE: Record<LabelAnchor, "bottom" | "top" | "middle"> = {
      above: "bottom",
      below: "top",
      middle: "middle",
    };
    return [
      {
        type: "text",
        attrs: {
          x: coordinates[0].x,
          y: coordinates[0].y + DY[anchor],
          text,
          align: "center",
          baseline: BASELINE[anchor],
        },
        styles: { ...LABEL_STYLES, color },
        ignoreEvent: true,
      },
    ];
  },
};

const LABELED_SEGMENT_OVERLAY = {
  name: "labeledSegment",
  totalStep: 2,
  needDefaultPointFigure: false,
  needDefaultXAxisFigure: false,
  needDefaultYAxisFigure: false,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createPointFigures: ({ overlay, coordinates }: any) => {
    if (!coordinates || coordinates.length < 2) return [];
    const data = overlay.extendData ?? {};
    const text = typeof data.text === "string" ? data.text : "";
    const color = typeof data.color === "string" ? data.color : NEUTRAL_COLOR;
    const anchor: "above" | "below" = data.anchor === "below" ? "below" : "above";
    const dy = anchor === "above" ? -LABEL_Y_OFFSET : LABEL_Y_OFFSET;
    const baseline = anchor === "above" ? "bottom" : "top";
    const midX = (coordinates[0].x + coordinates[1].x) / 2;
    const midY = (coordinates[0].y + coordinates[1].y) / 2;
    return [
      {
        type: "line",
        attrs: { coordinates },
        styles: { color, style: LineType.Dashed, size: 2, dashedValue: [4, 4] },
        ignoreEvent: true,
      },
      {
        type: "text",
        attrs: { x: midX, y: midY + dy, text, align: "center", baseline },
        styles: { ...LABEL_STYLES, color },
        ignoreEvent: true,
      },
    ];
  },
};

/** Custom overlay: filled + stroked rectangle between two corner
 *  points. Klinecharts v9 has NO built-in rectangle OVERLAY — only a
 *  low-level `rect` figure primitive that other overlays use. Calling
 *  `createOverlay({ name: 'rect' })` silently no-ops (the FVG fill was
 *  never visible because of this).
 *
 *  Right-edge clamp: klinecharts keeps "future space" past the last
 *  bar (the area beyond the latest candle where new bars will appear).
 *  Our extend-to-edge FVG/IFVG zones end at the LAST BAR'S timestamp,
 *  but coordinates beyond the data range map to that future space, so
 *  rectangles visually extend into it. We clamp the right edge to the
 *  last data bar's actual x via chart.getDataList() + convertToPixel
 *  so zones stop AT the last candle, not in the empty space.
 *
 *  Points define opposite corners. extendData: { color, fillAlpha,
 *  borderAlpha }. */
const ZONE_RECT_OVERLAY = {
  name: "zoneRect",
  totalStep: 2,
  needDefaultPointFigure: false,
  needDefaultXAxisFigure: false,
  needDefaultYAxisFigure: false,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createPointFigures: ({ overlay, coordinates, chart, xAxis }: any) => {
    if (!coordinates || coordinates.length < 2) return [];
    const data = overlay.extendData ?? {};
    const baseColor: string = data.color ?? NEUTRAL_COLOR;
    const fillAlpha: number = typeof data.fillAlpha === "number" ? data.fillAlpha : 0.18;
    const borderAlpha: number = typeof data.borderAlpha === "number" ? data.borderAlpha : 0.5;
    const fill = baseColor.replace(/,[\d.]+\)$/, `,${fillAlpha})`);
    const border = baseColor.replace(/,[\d.]+\)$/, `,${borderAlpha})`);

    // Find the last data bar's pixel x — used to clamp the right edge
    // so the rectangle doesn't extend into klinecharts' future space.
    // Use xAxis.convertToPixel(dataIndex) which is more reliable than
    // chart.convertToPixel(timestamp) for this. dataIndex of the last
    // bar = dataList.length - 1.
    let lastBarX = Infinity;
    try {
      const dataList = chart?.getDataList?.() ?? [];
      const lastIdx = dataList.length - 1;
      if (lastIdx >= 0 && xAxis?.convertToPixel) {
        const px = xAxis.convertToPixel(lastIdx);
        if (typeof px === "number" && isFinite(px)) lastBarX = px;
      }
    } catch {
      // Fallback: no clamp.
    }

    const rawLeftX = Math.min(coordinates[0].x, coordinates[1].x);
    const rawRightX = Math.max(coordinates[0].x, coordinates[1].x);
    const rightX = Math.min(rawRightX, lastBarX);
    const x = rawLeftX;
    const width = Math.max(0, rightX - rawLeftX);
    const y = Math.min(coordinates[0].y, coordinates[1].y);
    const height = Math.abs(coordinates[1].y - coordinates[0].y);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const figures: any[] = [
      {
        type: "rect",
        attrs: { x, y, width, height },
        styles: {
          style: PolygonType.StrokeFill,
          color: fill,
          borderColor: border,
          borderSize: 1,
          borderStyle: LineType.Solid,
          borderDashedValue: [],
        },
        ignoreEvent: true,
      },
    ];
    // Optional label at the rectangle's visible center. Uses the
    // CLAMPED right edge so the text stays inside the visible portion
    // of zones that extend past the last bar.
    const text = typeof data.text === "string" ? data.text : "";
    if (text && width > 24) {
      figures.push({
        type: "text",
        attrs: {
          x: x + width / 2,
          y: y + height / 2,
          text,
          align: "center",
          baseline: "middle",
        },
        styles: { ...LABEL_STYLES, color: baseColor },
        ignoreEvent: true,
      });
    }
    return figures;
  },
};

let registered = false;
export function ensureCustomOverlaysRegistered(): void {
  if (registered) return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerOverlay(TEXT_LABEL_OVERLAY as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerOverlay(LABELED_SEGMENT_OVERLAY as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerOverlay(ZONE_RECT_OVERLAY as any);
  registered = true;
}
