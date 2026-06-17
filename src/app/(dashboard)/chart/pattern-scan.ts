/**
 * Server-side pattern scanning helpers for the chart actions.
 * Walks a PriceBar series and turns each detector hit into a typed
 * PatternPoint (with UTC-seconds time aligned to the chart bars).
 *
 * Co-located with chart actions to keep the action file under
 * max-lines and isolate the pattern-detector call sites for easier
 * extension (next: zone shading, daily-bias multi-bar series).
 */
import { detectBos } from "@/lib/patterns/bos";
import { detectChoch } from "@/lib/patterns/choch";
import { detectDailyBias } from "@/lib/patterns/daily-bias";
import { scanFvgs } from "@/lib/patterns/fvg";
import { detectLiquiditySweep } from "@/lib/patterns/liquidity-sweep";
import { detectOrderBlock } from "@/lib/patterns/order-block";
import type { ChartBar, ChartPatterns, PatternPoint } from "./actions";

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

function scanBosAndSweeps(
  bars: PriceBarLike[],
  chartBars: ChartBar[]
): { bos: PatternPoint[]; sweep: PatternPoint[]; choch: PatternPoint[] } {
  const bos: PatternPoint[] = [];
  const sweep: PatternPoint[] = [];
  const choch: PatternPoint[] = [];
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
    }
    const s = detectLiquiditySweep(bars, i, 5);
    if (s.detected && s.details) {
      sweep.push({
        time,
        direction: s.details.direction,
        label: `Sweep ${s.details.direction} of ${fmtPrice(s.details.swept_level)}`,
        top: s.details.swept_level,
      });
    }
    const c = detectChoch(bars, i, 5);
    if (c.detected && c.details) {
      const d = (c.details as { direction?: "bullish" | "bearish" }).direction ?? "neutral";
      choch.push({ time, direction: d, label: `ChoCh ${d}` });
    }
  }
  return { bos, sweep, choch };
}

function scanOrderBlocks(bars: PriceBarLike[], chartBars: ChartBar[]): PatternPoint[] {
  const out: PatternPoint[] = [];
  for (let i = 2; i < bars.length; i++) {
    const r = detectOrderBlock(bars, i, {});
    if (!r.detected || !r.details) continue;
    const d = r.details;
    out.push({
      time: chartBars[i].time,
      direction: d.direction,
      label: `OB ${d.direction} ${fmtPrice(d.ob_low)}-${fmtPrice(d.ob_high)}`,
      top: d.ob_high,
      bottom: d.ob_low,
    });
  }
  return out;
}

function scanFvgsAndIfvgs(
  bars: PriceBarLike[],
  chartBars: ChartBar[]
): { fvg: PatternPoint[]; ifvg: PatternPoint[] } {
  const fvg: PatternPoint[] = [];
  const ifvg: PatternPoint[] = [];
  const gaps = scanFvgs(bars);
  for (const g of gaps) {
    fvg.push({
      time: chartBars[g.gap.created_at_idx].time,
      direction: g.gap.direction,
      label: `FVG ${g.gap.direction} ${fmtPrice(g.gap.gap_bottom)}-${fmtPrice(g.gap.gap_top)}`,
      top: g.gap.gap_top,
      bottom: g.gap.gap_bottom,
    });
    if (g.filled_at != null && g.filled_at < chartBars.length) {
      ifvg.push({
        time: chartBars[g.filled_at].time,
        direction: g.gap.direction === "bullish" ? "bearish" : "bullish",
        label: `IFVG ${g.gap.direction === "bullish" ? "bearish" : "bullish"} flip`,
        top: g.gap.gap_top,
        bottom: g.gap.gap_bottom,
      });
    }
  }
  return { fvg, ifvg };
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

export function computePatterns(rawBars: PriceBarLike[], bars: ChartBar[]): ChartPatterns {
  const { fvg, ifvg } = scanFvgsAndIfvgs(rawBars, bars);
  const { bos, sweep, choch } = scanBosAndSweeps(rawBars, bars);
  const order_block = scanOrderBlocks(rawBars, bars);
  const daily_bias = computeDailyBias(rawBars);
  return { fvg, ifvg, bos, sweep, order_block, choch, daily_bias };
}
