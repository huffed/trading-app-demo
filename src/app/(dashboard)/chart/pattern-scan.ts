/**
 * Server-side pattern scanning for the chart. Produces PatternPoint[]
 * (single-bar markers), PatternAnnotation[] (multi-bar lines + zones),
 * and SwingMarker[] (HH/HL/LH/LL). Patterns are computed on the bars
 * of the selected timeframe — not cross-TF.
 */
import { detectBos } from "@/lib/patterns/bos";
import { detectChoch } from "@/lib/patterns/choch";
import { detectDailyBias } from "@/lib/patterns/daily-bias";
import { scanFvgs } from "@/lib/patterns/fvg";
import { detectLiquiditySweep } from "@/lib/patterns/liquidity-sweep";
import { detectOrderBlock } from "@/lib/patterns/order-block";
import { detectSwingPoints } from "@/lib/patterns/swing-points";
import { buildBosResult, buildChochResult, buildSweepResult } from "./pattern-builders";
import type {
  ChartBar,
  ChartPatterns,
  PatternAnnotation,
  PatternPoint,
  SwingMarker,
} from "./actions";

type PriceBarLike = {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

function fmtPrice(p: number): string {
  if (Math.abs(p) >= 100) return p.toFixed(2);
  if (Math.abs(p) >= 1) return p.toFixed(4);
  return p.toFixed(5);
}

/** Forward-extension caps for unfilled zones. Each zone shows a
 *  visible right-edge stroke at this distance from formation so the
 *  operator can see where it ends, rather than the zone blending
 *  invisibly into the right edge of the chart. */
const FVG_FORWARD_BARS = 20;
const OB_FORWARD_BARS = 30;

function scanBosAndSweeps(
  bars: PriceBarLike[],
  chartBars: ChartBar[]
): {
  bos: PatternPoint[];
  sweep: PatternPoint[];
  choch: PatternPoint[];
  annotations: PatternAnnotation[];
} {
  const bos: PatternPoint[] = [];
  const sweep: PatternPoint[] = [];
  const choch: PatternPoint[] = [];
  const annotations: PatternAnnotation[] = [];

  // De-dup: BOS / ChoCh / Sweep fire EVERY bar where the condition
  // holds. A sustained break stays detected for many bars, producing
  // overlapping lines at the same level. We track which swing-point
  // index we've already broken in each direction and only emit on
  // the FIRST bar that breaks a NEW swing.
  let lastBosHighIdx = -1;
  let lastBosLowIdx = -1;
  let lastSweepIdx = -1;
  let lastChochHighIdx = -1;
  let lastChochLowIdx = -1;

  for (let i = 5; i < bars.length; i++) {
    const time = chartBars[i].time;

    const b = detectBos(bars, i, 5);
    if (b.detected && b.details) {
      const dir = b.details.direction;
      const swingIdx = b.details.broken_swing_idx;
      const isNew = dir === "bullish" ? swingIdx !== lastBosHighIdx : swingIdx !== lastBosLowIdx;
      if (isNew) {
        if (dir === "bullish") lastBosHighIdx = swingIdx;
        else lastBosLowIdx = swingIdx;
        const r = buildBosResult(b.details, time, chartBars);
        bos.push(r.point);
        annotations.push(r.annotation);
      }
    }

    const s = detectLiquiditySweep(bars, i, 5);
    if (s.detected && s.details && s.details.swept_idx !== lastSweepIdx) {
      lastSweepIdx = s.details.swept_idx;
      const r = buildSweepResult(s.details, time, chartBars);
      sweep.push(r.point);
      annotations.push(r.annotation);
    }

    const c = detectChoch(bars, i, 5);
    if (c.detected && c.details) {
      const cd = c.details as {
        direction?: "bullish" | "bearish";
        broken_level?: number;
        broken_swing_idx?: number;
      };
      const d = cd.direction ?? "neutral";
      if (cd.broken_level != null && cd.broken_swing_idx != null) {
        const isNew =
          d === "bullish"
            ? cd.broken_swing_idx !== lastChochHighIdx
            : cd.broken_swing_idx !== lastChochLowIdx;
        if (isNew) {
          if (d === "bullish") lastChochHighIdx = cd.broken_swing_idx;
          else lastChochLowIdx = cd.broken_swing_idx;
          const r = buildChochResult(
            { direction: d, broken_swing_idx: cd.broken_swing_idx, broken_level: cd.broken_level },
            time,
            chartBars
          );
          choch.push(r.point);
          annotations.push(r.annotation);
        }
      }
    }
  }
  return { bos, sweep, choch, annotations };
}

/** Walk forward from the OB formation bar until price CLOSES through
 *  the opposite side of the zone (mitigation), capped at
 *  OB_FORWARD_BARS. Returns the bar index where the zone should end. */
function findObEndIdx(
  bars: PriceBarLike[],
  ob: { ob_idx: number; ob_high: number; ob_low: number; direction: "bullish" | "bearish" }
): number {
  const cap = Math.min(ob.ob_idx + OB_FORWARD_BARS, bars.length - 1);
  for (let j = ob.ob_idx + 1; j <= cap; j++) {
    const mitigated =
      ob.direction === "bullish" ? bars[j].close < ob.ob_low : bars[j].close > ob.ob_high;
    if (mitigated) return j;
  }
  return cap;
}

function scanOrderBlocks(
  bars: PriceBarLike[],
  chartBars: ChartBar[]
): { points: PatternPoint[]; annotations: PatternAnnotation[] } {
  const points: PatternPoint[] = [];
  const annotations: PatternAnnotation[] = [];
  // detectOrderBlock fires on EVERY bar where price is currently inside
  // a prior OB zone. A 10-bar pullback into one OB therefore emits 10
  // overlapping rectangles at the same level. Dedup by formation index
  // so each unique OB renders exactly once, anchored at the OB candle
  // (the trader-convention reference frame) and ending at first
  // mitigation or +OB_FORWARD_BARS, whichever is first.
  const seen = new Set<number>();
  for (let i = 2; i < bars.length; i++) {
    const r = detectOrderBlock(bars, i, {});
    if (!r.detected || !r.details) continue;
    const d = r.details;
    if (seen.has(d.ob_idx)) continue;
    seen.add(d.ob_idx);
    const endIdx = findObEndIdx(bars, d);
    points.push({
      time: chartBars[d.ob_idx].time,
      direction: d.direction,
      label: `OB ${d.direction} ${fmtPrice(d.ob_low)}-${fmtPrice(d.ob_high)}`,
      top: d.ob_high,
      bottom: d.ob_low,
    });
    annotations.push({
      pattern_type: "order_block",
      kind: "zone",
      direction: d.direction,
      from_time: chartBars[d.ob_idx].time,
      to_time: chartBars[endIdx].time,
      top: d.ob_high,
      bottom: d.ob_low,
      label: "OB",
    });
  }
  return { points, annotations };
}

function scanFvgsAndIfvgs(
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
    // FVG zone: starts at the THIRD bar of the 3-bar pattern (where
    // the gap is fully confirmed), ends at filled_at OR a fixed
    // forward window from formation (so each zone has a clear visible
    // right-edge stroke instead of blending into the chart edge).
    const startIdx = Math.min(g.gap.created_at_idx + 1, lastBarIdx);
    const forwardEnd = Math.min(g.gap.created_at_idx + FVG_FORWARD_BARS, lastBarIdx);
    const endIdx = g.filled_at ?? forwardEnd;
    fvg.push({
      time: chartBars[g.gap.created_at_idx].time,
      direction: g.gap.direction,
      label: `FVG ${g.gap.direction} ${fmtPrice(g.gap.gap_bottom)}-${fmtPrice(g.gap.gap_top)}`,
      top: g.gap.gap_top,
      bottom: g.gap.gap_bottom,
    });
    // FVG zone annotation: only emit for UNFILLED gaps. Once a gap
    // is filled it's mitigated; the chart would be a mess of
    // overlapping zones across a long history if we kept them all.
    // Filled gaps surface as IFVG (inverse) zones below.
    if (g.filled_at == null) {
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
    }
    if (g.filled_at != null && g.filled_at < chartBars.length) {
      const flipDir = g.gap.direction === "bullish" ? "bearish" : "bullish";
      ifvg.push({
        time: chartBars[g.filled_at].time,
        direction: flipDir,
        label: `IFVG ${flipDir} flip`,
        top: g.gap.gap_top,
        bottom: g.gap.gap_bottom,
      });
      const ifvgEnd = Math.min(g.filled_at + FVG_FORWARD_BARS, lastBarIdx);
      annotations.push({
        pattern_type: "ifvg",
        kind: "zone",
        direction: flipDir,
        from_time: chartBars[g.filled_at].time,
        // IFVG extends forward by FVG_FORWARD_BARS so it has a visible
        // right-edge stroke instead of blending into the chart edge.
        to_time: chartBars[ifvgEnd].time,
        top: g.gap.gap_top,
        bottom: g.gap.gap_bottom,
        label: "IFVG",
      });
    }
  }
  return { fvg, ifvg, annotations };
}

function computeDailyBias(bars: PriceBarLike[]): ChartPatterns["daily_bias"] {
  const r = detectDailyBias(bars, 20);
  if (!r.detected || !r.details) return null;
  return {
    bias: r.details.bias,
    ma_value: r.details.ma_value,
    ma_period: r.details.ma_period,
  };
}

/** Walk detected swing points and label each one HH / LH / HL / LL by
 *  comparing to the previous same-type swing. The first high is "HH"
 *  by convention (no prior to compare); same for the first low. */
function computeSwings(bars: PriceBarLike[], chartBars: ChartBar[]): SwingMarker[] {
  const swings = detectSwingPoints(bars, 5);
  const out: SwingMarker[] = [];
  let prevHigh: number | null = null;
  let prevLow: number | null = null;
  for (const s of swings) {
    if (s.idx < 0 || s.idx >= chartBars.length) continue;
    const time = chartBars[s.idx].time;
    if (s.type === "high") {
      const label: "HH" | "LH" = prevHigh == null || s.price >= prevHigh ? "HH" : "LH";
      out.push({ time, type: label, price: s.price });
      prevHigh = s.price;
    } else {
      const label: "HL" | "LL" = prevLow == null || s.price >= prevLow ? "HL" : "LL";
      out.push({ time, type: label, price: s.price });
      prevLow = s.price;
    }
  }
  return out;
}

export function computePatterns(rawBars: PriceBarLike[], bars: ChartBar[]): ChartPatterns {
  const fvgResult = scanFvgsAndIfvgs(rawBars, bars);
  const bosResult = scanBosAndSweeps(rawBars, bars);
  const obResult = scanOrderBlocks(rawBars, bars);
  const daily_bias = computeDailyBias(rawBars);
  const swings = computeSwings(rawBars, bars);
  const annotations = [
    ...fvgResult.annotations,
    ...bosResult.annotations,
    ...obResult.annotations,
  ];
  return {
    fvg: fvgResult.fvg,
    ifvg: fvgResult.ifvg,
    bos: bosResult.bos,
    sweep: bosResult.sweep,
    choch: bosResult.choch,
    order_block: obResult.points,
    annotations,
    swings,
    daily_bias,
  };
}
