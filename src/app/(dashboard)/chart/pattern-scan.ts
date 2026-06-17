/**
 * Server-side pattern scanning helpers for the chart actions.
 * Walks a PriceBar series and produces both:
 *   - PatternPoint[] — single-bar marker style (legacy display)
 *   - PatternAnnotation[] — trader-familiar lines + zones spanning the
 *     multi-bar structure each pattern actually occupies
 *   - SwingMarker[] — HH/HL/LH/LL labels at confirmed swing points
 *
 * All patterns are computed on the bars provided to the action — which
 * is the timeframe the operator selected. A 4h BOS is detected from
 * 4h swings; a 1h BOS from 1h swings. They're not cross-TF.
 */
import { detectBos } from "@/lib/patterns/bos";
import { detectChoch } from "@/lib/patterns/choch";
import { detectDailyBias } from "@/lib/patterns/daily-bias";
import { scanFvgs } from "@/lib/patterns/fvg";
import { detectLiquiditySweep } from "@/lib/patterns/liquidity-sweep";
import { detectOrderBlock } from "@/lib/patterns/order-block";
import { detectSwingPoints } from "@/lib/patterns/swing-points";
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

/** Forward-extension bars for unfilled zones (FVG, OB). Keeps the zone
 *  visible past the formation bar so the operator sees what level it
 *  occupies, without extending all the way to the right edge. */
const ZONE_FORWARD_BARS = 30;

function timeAt(chartBars: ChartBar[], idx: number): number {
  const clamped = Math.max(0, Math.min(idx, chartBars.length - 1));
  return chartBars[clamped].time;
}

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
  for (let i = 5; i < bars.length; i++) {
    const time = chartBars[i].time;
    const b = detectBos(bars, i, 5);
    if (b.detected && b.details) {
      bos.push({
        time,
        direction: b.details.direction,
        label: `BOS ${b.details.direction} @ ${fmtPrice(b.details.broken_level)}`,
        top: b.details.broken_level,
      });
      annotations.push({
        pattern_type: "bos",
        kind: "line",
        direction: b.details.direction,
        from_time: timeAt(chartBars, b.details.broken_swing_idx),
        to_time: time,
        top: b.details.broken_level,
        label: "BOS",
      });
    }
    const s = detectLiquiditySweep(bars, i, 5);
    if (s.detected && s.details) {
      sweep.push({
        time,
        direction: s.details.direction,
        label: `Sweep ${s.details.direction} of ${fmtPrice(s.details.swept_level)}`,
        top: s.details.swept_level,
      });
      annotations.push({
        pattern_type: "sweep",
        kind: "line",
        direction: s.details.direction,
        from_time: timeAt(chartBars, s.details.swept_idx),
        to_time: time,
        top: s.details.swept_level,
        label: "Sweep",
      });
    }
    const c = detectChoch(bars, i, 5);
    if (c.detected && c.details) {
      const cd = c.details as {
        direction?: "bullish" | "bearish";
        broken_level?: number;
        broken_swing_idx?: number;
      };
      const d = cd.direction ?? "neutral";
      choch.push({ time, direction: d, label: `ChoCh ${d}` });
      if (cd.broken_level != null && cd.broken_swing_idx != null) {
        annotations.push({
          pattern_type: "choch",
          kind: "line",
          direction: d,
          from_time: timeAt(chartBars, cd.broken_swing_idx),
          to_time: time,
          top: cd.broken_level,
          label: "ChoCh",
        });
      }
    }
  }
  return { bos, sweep, choch, annotations };
}

function scanOrderBlocks(
  bars: PriceBarLike[],
  chartBars: ChartBar[]
): { points: PatternPoint[]; annotations: PatternAnnotation[] } {
  const points: PatternPoint[] = [];
  const annotations: PatternAnnotation[] = [];
  for (let i = 2; i < bars.length; i++) {
    const r = detectOrderBlock(bars, i, {});
    if (!r.detected || !r.details) continue;
    const d = r.details;
    points.push({
      time: chartBars[i].time,
      direction: d.direction,
      label: `OB ${d.direction} ${fmtPrice(d.ob_low)}-${fmtPrice(d.ob_high)}`,
      top: d.ob_high,
      bottom: d.ob_low,
    });
    annotations.push({
      pattern_type: "order_block",
      kind: "zone",
      direction: d.direction,
      from_time: chartBars[i].time,
      to_time: timeAt(chartBars, i + ZONE_FORWARD_BARS),
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
  for (const g of gaps) {
    // FVG zone — created at idx, extends until filled (or forward by
    // a fixed window for visualization purposes).
    const startIdx = Math.max(0, g.gap.created_at_idx - 1);
    const endIdx =
      g.filled_at != null
        ? g.filled_at
        : Math.min(g.gap.created_at_idx + ZONE_FORWARD_BARS, chartBars.length - 1);
    fvg.push({
      time: chartBars[g.gap.created_at_idx].time,
      direction: g.gap.direction,
      label: `FVG ${g.gap.direction} ${fmtPrice(g.gap.gap_bottom)}-${fmtPrice(g.gap.gap_top)}`,
      top: g.gap.gap_top,
      bottom: g.gap.gap_bottom,
    });
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
    if (g.filled_at != null && g.filled_at < chartBars.length) {
      const flipDir = g.gap.direction === "bullish" ? "bearish" : "bullish";
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
        to_time: chartBars[Math.min(g.filled_at + ZONE_FORWARD_BARS, chartBars.length - 1)].time,
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
