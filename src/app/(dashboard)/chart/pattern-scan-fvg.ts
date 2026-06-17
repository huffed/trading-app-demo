/**
 * FVG / IFVG scan logic. Split from pattern-scan.ts to stay under
 * max-lines. Exports scanFvgsAndIfvgs which produces the chart-ready
 * point + annotation arrays for both layers.
 */
import { scanFvgs } from "@/lib/patterns/fvg";
import type {
  ChartBar,
  PatternAnnotation,
  PatternPoint,
} from "./actions";

type PriceBarLike = {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

const FVG_FORWARD_BARS = 20;
/** Cap how far forward an IFVG (filled FVG that flipped role) extends
 *  before it's deemed stale even without an explicit re-violation. */
const IFVG_FORWARD_BARS = 40;

/** Minimum FVG gap size as a multiple of ATR(14) at formation. Smaller
 *  gaps are noise — a 3-bar imbalance where the gap is a fraction of
 *  a typical bar's range isn't a meaningful zone. */
const FVG_MIN_ATR_RATIO = 0.25;

function fmtPrice(p: number): string {
  if (Math.abs(p) >= 100) return p.toFixed(2);
  if (Math.abs(p) >= 1) return p.toFixed(4);
  return p.toFixed(5);
}

function atr14(bars: PriceBarLike[], idx: number): number {
  const period = 14;
  if (idx < period) return 0;
  let sum = 0;
  for (let i = idx - period + 1; i <= idx; i++) {
    if (i === 0) {
      sum += bars[i].high - bars[i].low;
      continue;
    }
    const prevClose = bars[i - 1].close;
    sum += Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - prevClose),
      Math.abs(bars[i].low - prevClose)
    );
  }
  return sum / period;
}

/** Walk forward from the fill bar until price re-violates the IFVG
 *  zone (closes back through in the ORIGINAL FVG's direction). Returns
 *  the cap when no violation is found. */
function findIfvgEndIdx(
  bars: PriceBarLike[],
  fillIdx: number,
  gapTop: number,
  gapBottom: number,
  originalDirection: "bullish" | "bearish"
): number {
  const cap = Math.min(fillIdx + IFVG_FORWARD_BARS, bars.length - 1);
  for (let j = fillIdx + 1; j <= cap; j++) {
    const violated =
      originalDirection === "bullish" ? bars[j].close > gapTop : bars[j].close < gapBottom;
    if (violated) return j;
  }
  return cap;
}

export function scanFvgsAndIfvgs(
  bars: PriceBarLike[],
  chartBars: ChartBar[]
): {
  fvg: PatternPoint[];
  ifvg: PatternPoint[];
  annotations: PatternAnnotation[];
} {
  const fvg: PatternPoint[] = [];
  const ifvg: PatternPoint[] = [];
  const annotations: PatternAnnotation[] = [];
  const gaps = scanFvgs(bars);
  const lastBarIdx = chartBars.length - 1;
  for (const g of gaps) {
    const gapSize = g.gap.gap_top - g.gap.gap_bottom;
    const a = atr14(bars, g.gap.created_at_idx);
    if (a > 0 && gapSize < a * FVG_MIN_ATR_RATIO) continue;

    const startIdx = Math.max(0, g.gap.created_at_idx - 1);

    fvg.push({
      time: chartBars[g.gap.created_at_idx].time,
      direction: g.gap.direction,
      label: `FVG ${g.gap.direction} ${fmtPrice(g.gap.gap_bottom)}-${fmtPrice(g.gap.gap_top)}`,
      top: g.gap.gap_top,
      bottom: g.gap.gap_bottom,
    });

    if (g.filled_at == null) {
      const endIdx = Math.min(g.gap.created_at_idx + FVG_FORWARD_BARS, lastBarIdx);
      annotations.push({
        pattern_type: "fvg",
        kind: "zone",
        direction: g.gap.direction,
        from_time: chartBars[startIdx].time,
        to_time: chartBars[endIdx].time,
        top: g.gap.gap_top,
        bottom: g.gap.gap_bottom,
        label: "FVG",
      });
      continue;
    }

    if (g.filled_at < chartBars.length) {
      const flipDir = g.gap.direction === "bullish" ? "bearish" : "bullish";
      const endIdx = findIfvgEndIdx(
        bars,
        g.filled_at,
        g.gap.gap_top,
        g.gap.gap_bottom,
        g.gap.direction
      );
      ifvg.push({
        time: chartBars[g.filled_at].time,
        direction: flipDir,
        label: `IFVG ${flipDir} flip`,
        top: g.gap.gap_top,
        bottom: g.gap.gap_bottom,
      });
      annotations.push({
        pattern_type: "ifvg",
        kind: "zone",
        direction: flipDir,
        from_time: chartBars[g.filled_at].time,
        to_time: chartBars[endIdx].time,
        top: g.gap.gap_top,
        bottom: g.gap.gap_bottom,
        label: "IFVG",
      });
    }
  }
  return { fvg, ifvg, annotations };
}
