/**
 * Context summarisers for the LLM-trader prompt. Extracted from
 * `llm-trader.ts` on 2026-06-22 (CB.H1 pass 15). Each function condenses
 * one slice of market context (D1 bias, recent bars, DXY, intermarket,
 * higher-TF structure, position state) into a single line of prompt text
 * the LLM reads at evaluation time. Pure functions — no I/O, no LLM.
 */
import type { PriceBar } from "@/lib/market-data/types";
import type { LlmTraderContext, Regime } from "./llm-trader";

export function summariseDailyBias(dailyBars: PriceBar[]): { summary: string; regime: Regime } {
  if (dailyBars.length < 21) return { summary: "daily: n/a", regime: "n/a" };
  const recent = dailyBars.slice(-14);
  const last = dailyBars[dailyBars.length - 1];
  const sma20 = dailyBars.slice(-20).reduce((s, b) => s + b.close, 0) / 20;
  const greenDays = recent.filter((b) => b.close > b.open).length;
  const high14 = Math.max(...recent.map((b) => b.high));
  const low14 = Math.min(...recent.map((b) => b.low));
  const last3High = Math.max(...recent.slice(-3).map((b) => b.high));
  const prev3High = Math.max(...recent.slice(-7, -3).map((b) => b.high));
  const last3Low = Math.min(...recent.slice(-3).map((b) => b.low));
  const prev3Low = Math.min(...recent.slice(-7, -3).map((b) => b.low));
  let regime: Regime;
  if (last3High > prev3High && last3Low > prev3Low) regime = "HH";
  else if (last3High < prev3High && last3Low < prev3Low) regime = "LH";
  else regime = "RANGING";
  const smaPct = ((last.close - sma20) / sma20) * 100;
  const summary = `D1 structure: ${regime}. Close ${last.close.toFixed(0)} (${smaPct >= 0 ? "+" : ""}${smaPct.toFixed(2)}% vs SMA20 ${sma20.toFixed(0)}). 14d ${greenDays}G/${14 - greenDays}R. Range ${low14.toFixed(0)}-${high14.toFixed(0)}.`;
  return { summary, regime };
}

export function computeAtr(bars: PriceBar[], period: number, idx: number): number {
  const start = Math.max(1, idx - period + 1);
  let sum = 0;
  let count = 0;
  for (let i = start; i <= idx; i++) {
    const tr = Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - bars[i - 1].close),
      Math.abs(bars[i].low - bars[i - 1].close)
    );
    sum += tr;
    count++;
  }
  return count > 0 ? sum / count : 0;
}

export function summariseRecentBars(bars: PriceBar[], idx: number, tfLabel: string): string {
  const start = Math.max(0, idx - 19);
  const window = bars.slice(start, idx + 1);
  const cur = window[window.length - 1];
  const swingHigh = Math.max(...window.map((b) => b.high));
  const swingLow = Math.min(...window.map((b) => b.low));
  const last3 = window.slice(-3);
  const last3Lines = last3.map((b) => {
    const dir = b.close > b.open ? "↑" : "↓";
    return `${b.date.slice(11, 16)} ${b.open.toFixed(0)}-${b.close.toFixed(0)} ${dir} (H${b.high.toFixed(0)} L${b.low.toFixed(0)})`;
  });
  const mom3 =
    window.length >= 4
      ? ((cur.close - window[window.length - 4].close) / window[window.length - 4].close) * 100
      : 0;
  const atr14 = computeAtr(bars, 14, idx);
  const distHi = ((swingHigh - cur.close) / cur.close) * 100;
  const distLo = ((cur.close - swingLow) / cur.close) * 100;
  return (
    `${tfLabel}: cur ${cur.close.toFixed(0)}, 20-bar range ${swingLow.toFixed(0)}-${swingHigh.toFixed(0)} ` +
    `(dist hi ${distHi.toFixed(1)}% / lo ${distLo.toFixed(1)}%), 3-bar mom ${mom3 >= 0 ? "+" : ""}${mom3.toFixed(2)}%, ATR14 ${atr14.toFixed(1)}.\n` +
    `Last 3 bars: ${last3Lines.join(" | ")}`
  );
}

export function summariseDxy(eurusdBars: PriceBar[] | null | undefined, currentTs: string): string {
  if (!eurusdBars || eurusdBars.length === 0) return "DXY: n/a";
  const ts = new Date(currentTs).getTime();
  const cutoff24h = ts - 24 * 3600 * 1000;
  const cutoff7d = ts - 7 * 24 * 3600 * 1000;
  const before24h = eurusdBars.findLast((b) => new Date(b.date).getTime() <= cutoff24h);
  const before7d = eurusdBars.findLast((b) => new Date(b.date).getTime() <= cutoff7d);
  const latest = eurusdBars.findLast((b) => new Date(b.date).getTime() <= ts);
  if (!before24h || !before7d || !latest) return "DXY: n/a";
  const c24 = ((latest.close - before24h.close) / before24h.close) * 100;
  const c7 = ((latest.close - before7d.close) / before7d.close) * 100;
  return `DXY: 24h ${-c24 >= 0 ? "+" : ""}${(-c24).toFixed(2)}% / 7d ${-c7 >= 0 ? "+" : ""}${(-c7).toFixed(2)}%.`;
}

export function summariseIntermarket(
  im: NonNullable<LlmTraderContext["intermarket"]> | undefined,
  goldClose: number,
  currentTs: string
): string {
  if (!im) return "Intermarket: n/a";
  const ts = new Date(currentTs).getTime();
  const cutoff24h = ts - 24 * 3600 * 1000;
  const cutoff7d = ts - 7 * 24 * 3600 * 1000;
  const lookup = (bars: PriceBar[] | undefined, cutoff: number): PriceBar | undefined => {
    if (!bars) return undefined;
    return bars.findLast((b) => new Date(b.date).getTime() <= cutoff);
  };
  const parts: string[] = [];
  const slvLatest = lookup(im.silver, ts);
  const slv7d = lookup(im.silver, cutoff7d);
  if (slvLatest && slv7d) {
    const ratioNow = goldClose / slvLatest.close;
    const slvChange7d = ((slvLatest.close - slv7d.close) / slv7d.close) * 100;
    parts.push(
      `XAU/XAG ${ratioNow.toFixed(0)} (silver 7d ${slvChange7d >= 0 ? "+" : ""}${slvChange7d.toFixed(2)}%)`
    );
  }
  const tnxLatest = lookup(im.yield10y, ts);
  const tnx24h = lookup(im.yield10y, cutoff24h);
  if (tnxLatest && tnx24h) {
    const yieldChange = tnxLatest.close - tnx24h.close;
    parts.push(
      `10Y ${tnxLatest.close.toFixed(2)}% (24h ${yieldChange >= 0 ? "+" : ""}${yieldChange.toFixed(2)}pp)`
    );
  }
  const vixLatest = lookup(im.vix, ts);
  const vix24h = lookup(im.vix, cutoff24h);
  if (vixLatest && vix24h) {
    const vixChange = ((vixLatest.close - vix24h.close) / vix24h.close) * 100;
    parts.push(
      `VIX ${vixLatest.close.toFixed(0)} (24h ${vixChange >= 0 ? "+" : ""}${vixChange.toFixed(1)}%)`
    );
  }
  return parts.length > 0 ? `Intermarket: ${parts.join(" | ")}.` : "Intermarket: n/a";
}

/** Multi-TF structural read — for each higher TF, derive HH/LH/RANGING
 *  regime + 3-bar momentum + 20-bar range distance, condensed to one
 *  line. Lets the LLM see whether faster TFs have flipped ahead of D1's
 *  lagging 14-day window — addresses the transition-rally bottleneck
 *  identified in May 5-6 + Oct 2024 cases (D1 still LH while 1h/4h
 *  structurally HH on a fresh rally). Only the v5 prompt explicitly
 *  references this section; v3/v4 see the line but treat it as
 *  informational confluence. */
export function summariseHigherTfStructure(
  higherTfBars: NonNullable<LlmTraderContext["higherTfBars"]>,
  currentTs: string
): string {
  if (higherTfBars.length === 0) return "";
  const ts = new Date(currentTs).getTime();
  const lines: string[] = [];
  for (const { tfLabel, bars } of higherTfBars) {
    const before = bars.filter((b) => new Date(b.date).getTime() <= ts);
    if (before.length < 8) continue;
    const recent = before.slice(-14);
    const last3High = Math.max(...recent.slice(-3).map((b) => b.high));
    const prev3High = Math.max(...recent.slice(-7, -3).map((b) => b.high));
    const last3Low = Math.min(...recent.slice(-3).map((b) => b.low));
    const prev3Low = Math.min(...recent.slice(-7, -3).map((b) => b.low));
    let regime: "HH" | "LH" | "RANGING";
    if (last3High > prev3High && last3Low > prev3Low) regime = "HH";
    else if (last3High < prev3High && last3Low < prev3Low) regime = "LH";
    else regime = "RANGING";
    const window20 = before.slice(-20);
    const swingHigh = Math.max(...window20.map((b) => b.high));
    const swingLow = Math.min(...window20.map((b) => b.low));
    const cur = before[before.length - 1];
    const mom3 =
      before.length >= 4
        ? ((cur.close - before[before.length - 4].close) / before[before.length - 4].close) * 100
        : 0;
    lines.push(
      `${tfLabel}: ${regime} (range ${swingLow.toFixed(0)}-${swingHigh.toFixed(0)}, mom ${mom3 >= 0 ? "+" : ""}${mom3.toFixed(2)}%)`
    );
  }
  return lines.length > 0 ? `Higher TF: ${lines.join(" | ")}.` : "";
}

export function summarisePosition(
  position: LlmTraderContext["position"],
  currentPrice: number
): string {
  if (!position) return "FLAT.";
  const pnlPct =
    position.side === "long"
      ? ((currentPrice - position.entryPrice) / position.entryPrice) * 100
      : ((position.entryPrice - currentPrice) / position.entryPrice) * 100;
  const sl = position.stopPrice ? `SL ${position.stopPrice.toFixed(0)}` : "SL n/a";
  const tp = position.targetPrice ? `TP ${position.targetPrice.toFixed(0)}` : "TP n/a";
  // R-multiple — compute against the entry-time SL distance so BE-moves
  // don't change the denominator. The engine's move_be gate uses this
  // exact figure, and the LLM was previously hallucinating R from
  // assumed "typical" stop widths instead of reading the actual SL —
  // surface it explicitly so the model has nothing to guess.
  const slForR = position.initialStopPrice ?? position.stopPrice;
  let rTag = "";
  if (slForR && slForR !== position.entryPrice) {
    const slDistance = Math.abs(position.entryPrice - slForR);
    const currentR =
      position.side === "long"
        ? (currentPrice - position.entryPrice) / slDistance
        : (position.entryPrice - currentPrice) / slDistance;
    const oneRPrice =
      position.side === "long"
        ? position.entryPrice + slDistance
        : position.entryPrice - slDistance;
    rTag = `, R ${currentR >= 0 ? "+" : ""}${currentR.toFixed(2)} (+1R at ${oneRPrice.toFixed(0)})`;
  }
  return `${position.side.toUpperCase()} from ${position.entryPrice.toFixed(0)}, cur ${currentPrice.toFixed(0)}, P&L ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%${rTag}, ${sl}/${tp}.`;
}
