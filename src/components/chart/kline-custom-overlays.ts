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
 *  Points define opposite corners. extendData: { color, fillAlpha,
 *  borderAlpha } — color is the base rgba string (we strip the alpha
 *  and re-compose with the operator-set opacities). */
const ZONE_RECT_OVERLAY = {
  name: "zoneRect",
  totalStep: 2,
  needDefaultPointFigure: false,
  needDefaultXAxisFigure: false,
  needDefaultYAxisFigure: false,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createPointFigures: ({ overlay, coordinates }: any) => {
    if (!coordinates || coordinates.length < 2) return [];
    const data = overlay.extendData ?? {};
    const baseColor: string = data.color ?? NEUTRAL_COLOR;
    const fillAlpha: number = typeof data.fillAlpha === "number" ? data.fillAlpha : 0.18;
    const borderAlpha: number = typeof data.borderAlpha === "number" ? data.borderAlpha : 0.5;
    // Re-compose rgba with our alphas (assumes baseColor ends in ",1)"
    // which all our DIRECTION_RGB values do).
    const fill = baseColor.replace(/,[\d.]+\)$/, `,${fillAlpha})`);
    const border = baseColor.replace(/,[\d.]+\)$/, `,${borderAlpha})`);
    const x = Math.min(coordinates[0].x, coordinates[1].x);
    const y = Math.min(coordinates[0].y, coordinates[1].y);
    const width = Math.abs(coordinates[1].x - coordinates[0].x);
    const height = Math.abs(coordinates[1].y - coordinates[0].y);
    return [
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
