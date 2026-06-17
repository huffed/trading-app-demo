/**
 * Helpers for `pattern-scan.ts` — build PatternPoint + PatternAnnotation
 * pairs for break-style patterns (BOS, sweep, ChoCh). Extracted to
 * keep pattern-scan.ts under max-lines.
 */
import type { ChartBar, PatternAnnotation, PatternPoint } from "./actions";

export interface BreakResult {
  point: PatternPoint;
  annotation: PatternAnnotation;
}

function fmtPrice(p: number): string {
  if (Math.abs(p) >= 100) return p.toFixed(2);
  if (Math.abs(p) >= 1) return p.toFixed(4);
  return p.toFixed(5);
}

function timeAt(chartBars: ChartBar[], idx: number): number {
  const clamped = Math.max(0, Math.min(idx, chartBars.length - 1));
  return chartBars[clamped].time;
}

export function buildBosResult(
  details: { direction: "bullish" | "bearish"; broken_swing_idx: number; broken_level: number },
  time: number,
  chartBars: ChartBar[]
): BreakResult {
  return {
    point: {
      time,
      direction: details.direction,
      label: `BOS ${details.direction} @ ${fmtPrice(details.broken_level)}`,
      top: details.broken_level,
    },
    annotation: {
      pattern_type: "bos",
      kind: "line",
      direction: details.direction,
      from_time: timeAt(chartBars, details.broken_swing_idx),
      to_time: time,
      top: details.broken_level,
      label: "BOS",
    },
  };
}

export function buildSweepResult(
  details: { direction: "bullish" | "bearish"; swept_idx: number; swept_level: number },
  time: number,
  chartBars: ChartBar[]
): BreakResult {
  return {
    point: {
      time,
      direction: details.direction,
      label: `Sweep ${details.direction} of ${fmtPrice(details.swept_level)}`,
      top: details.swept_level,
    },
    annotation: {
      pattern_type: "sweep",
      kind: "line",
      direction: details.direction,
      from_time: timeAt(chartBars, details.swept_idx),
      to_time: time,
      top: details.swept_level,
      label: "Sweep",
    },
  };
}

export function buildChochResult(
  details: {
    direction: "bullish" | "bearish" | "neutral";
    broken_swing_idx: number;
    broken_level: number;
  },
  time: number,
  chartBars: ChartBar[]
): BreakResult {
  return {
    point: {
      time,
      direction: details.direction,
      label: `ChoCh ${details.direction}`,
    },
    annotation: {
      pattern_type: "choch",
      kind: "line",
      direction: details.direction,
      from_time: timeAt(chartBars, details.broken_swing_idx),
      to_time: time,
      top: details.broken_level,
      label: "ChoCh",
    },
  };
}
