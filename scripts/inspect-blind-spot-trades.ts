/* eslint-disable no-console */
/**
 * S1.5 priority #4 — investigate the 24% blind spot.
 *
 * Per project_friend_replay_2026_06, 9 of friend's 38 FTMO trades (24%)
 * had ZERO of our 8 pattern primitives fire in his direction at entry.
 * 3 winners + 6 losers. The roadmap question: what was he reading on
 * those trades that we don't detect?
 *
 * This script extends `replay-friend-trades.ts`: for each trade where
 * `allPrimitivesAlignedCount === 0`, dump rich context (entry bar +
 * surrounding 10 bars + daily context + structural notes) so the
 * operator can manually decide whether a missing-detector hypothesis
 * is worth building.
 *
 * Computed structural features per trade (not classified yet — we
 * surface raw data, let the inspector pattern-match):
 *   - Distance to nearest psychological "round" level (00 / 50 increments)
 *   - Recent 1h ATR + 1h ATR percentile (was vol low/high?)
 *   - Recent 24h high/low/range — was entry near a 24h extreme?
 *   - Daily VWAP-ish (rolling 24h OHLC4 mean) — was entry above/below?
 *   - Session boundary distance (was entry within ±1h of London / NY open?)
 *   - Entry vs prior 5-bar range (mid / extreme / breakout)
 *
 * Output:
 *   scripts/inspect-blind-spot-trades-<stamp>.json (raw)
 *   stdout: per-trade context blocks for manual inspection
 *
 * Usage:
 *   pnpm dlx tsx scripts/inspect-blind-spot-trades.ts
 */
import { readFileSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";
import { detectBos } from "../src/lib/patterns/bos";
import { detectChoch } from "../src/lib/patterns/choch";
import { detectDailyBias } from "../src/lib/patterns/daily-bias";
import { detectEqualLevels } from "../src/lib/patterns/equal-levels";
import { detectFvg } from "../src/lib/patterns/fvg";
import { detectLiquiditySweep } from "../src/lib/patterns/liquidity-sweep";
import { detectOrderBlock } from "../src/lib/patterns/order-block";
import { detectOte } from "../src/lib/patterns/ote";
import { loadCorpus } from "./llm-trader-backtest";

{
  try {
    const raw = readFileSync(".env.local", "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (!m) continue;
      const [, k, v] = m;
      if (!process.env[k]) process.env[k] = v.replace(/^['"]|['"]$/g, "");
    }
  } catch {
    /* ignore */
  }
}

const REFERENCES_DIR = "funded account references";
const BROKER_TZ_OFFSET_MINUTES = 120;

interface Trade {
  ticket: string;
  openUtc: Date;
  type: "buy" | "sell";
  volume: number;
  symbol: string;
  appSymbol: string;
  openPrice: number;
  profit: number;
  durationSec: number;
  isWin: boolean;
}

interface Bar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

function brokerTimestampToUtc(raw: string): Date {
  const [date, time] = raw.split(" ");
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm, ss] = time.split(":").map(Number);
  return new Date(Date.UTC(y, m - 1, d, hh, mm, ss) - BROKER_TZ_OFFSET_MINUTES * 60_000);
}

function mt5ToAppSymbol(mt5: string): string {
  const upper = mt5.toUpperCase();
  if (upper.length === 6) return `${upper.slice(0, 3)}/${upper.slice(3)}`;
  return upper;
}

function loadTrades(): Trade[] {
  const dir = join(process.cwd(), REFERENCES_DIR);
  const files = readdirSync(dir).filter((f) => f.endsWith(".csv"));
  const out: Trade[] = [];
  for (const f of files) {
    const text = readFileSync(join(dir, f), "utf8");
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    for (let i = 1; i < lines.length; i++) {
      const cells: string[] = [];
      let cur = "";
      let inQuote = false;
      for (const ch of lines[i]) {
        if (ch === '"') { inQuote = !inQuote; continue; }
        if (ch === "," && !inQuote) { cells.push(cur); cur = ""; continue; }
        cur += ch;
      }
      cells.push(cur);
      if (cells.length < 14) continue;
      const [ticket, open, type, volume, symbol, price, , , , , , , profit, , duration] = cells;
      if (!open || !type || !symbol) continue;
      const profitNum = Number(profit);
      out.push({
        ticket,
        openUtc: brokerTimestampToUtc(open),
        type: type as "buy" | "sell",
        volume: Number(volume),
        symbol,
        appSymbol: mt5ToAppSymbol(symbol),
        openPrice: Number(price),
        profit: profitNum,
        durationSec: Number(duration),
        isWin: profitNum > 0,
      });
    }
  }
  return out.sort((a, b) => a.openUtc.getTime() - b.openUtc.getTime());
}

function findBarIndex(bars: Bar[], targetMs: number): number {
  let last = -1;
  for (let i = 0; i < bars.length; i++) {
    const t = new Date(bars[i].date).getTime();
    if (Number.isFinite(t) && t <= targetMs) last = i;
    else break;
  }
  return last;
}

function aligned(direction: "bullish" | "bearish", bars: Bar[], i: number, dailyBars: Bar[]) {
  const tradeDay = bars[i].date.slice(0, 10);
  let dEnd = 0;
  for (let k = 0; k < dailyBars.length; k++) {
    if (dailyBars[k].date.slice(0, 10) <= tradeDay) dEnd = k + 1;
    else break;
  }
  const dailySlice = dailyBars.slice(0, dEnd);
  const bias = detectDailyBias(dailySlice, 20);
  const bos = detectBos(bars, i, 5);
  const ob = detectOrderBlock(bars, i, { lookback: 5 });
  const fvg = detectFvg(bars, i);
  const sweep = detectLiquiditySweep(bars, i, 5);
  const choch = detectChoch(bars, i, 5);
  const ote = detectOte(bars, i, 5);
  const eq = detectEqualLevels(bars, i, direction, { swingLookback: 5 });
  const hit = (det: { detected: boolean; details?: { direction?: string; bias?: string } }, key: "direction" | "bias") =>
    det.detected && det.details?.[key] === direction;
  return {
    daily_bias: hit(bias, "bias"),
    bos: hit(bos, "direction"),
    ob: hit(ob, "direction"),
    fvg: hit(fvg, "direction"),
    sweep: hit(sweep, "direction"),
    choch: hit(choch, "direction"),
    ote: hit(ote, "direction"),
    equal_levels: eq.detected,
  };
}

function atr14(bars: Bar[], end: number): number {
  if (end < 15) return 0;
  let sum = 0;
  for (let k = end - 13; k <= end; k++) {
    const prev = bars[k - 1];
    const cur = bars[k];
    const tr = Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prev.close),
      Math.abs(cur.low - prev.close)
    );
    sum += tr;
  }
  return sum / 14;
}

function atrPercentile(bars: Bar[], end: number, lookback = 200): number | null {
  if (end < lookback + 14) return null;
  const samples: number[] = [];
  for (let k = end - lookback; k <= end; k++) {
    samples.push(atr14(bars, k));
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const current = atr14(bars, end);
  const rank = sorted.findIndex((v) => v >= current);
  return rank < 0 ? 100 : Math.round((rank / sorted.length) * 100);
}

interface StructuralFeatures {
  /** Closest round-number level (e.g., 1.0500 for EUR/USD). Distance in pips. */
  nearestRoundDistPips: number;
  roundLevel: number;
  /** 14-bar ATR. Used as size reference. */
  atr14: number;
  /** ATR percentile over last 200 bars (0=lowest, 100=highest). */
  atrPctile: number | null;
  /** Position within last 24h (24 bars) range, 0=bottom 100=top. */
  pos24hRange: number;
  high24h: number;
  low24h: number;
  /** Entry price vs rolling 24-bar OHLC4 mean (a crude vwap proxy). */
  vwapPxDiffPct: number;
  /** Distance in minutes to nearest major session open (london=7utc, ny=13utc). */
  minsToLondon: number;
  minsToNy: number;
  /** Entry bar position vs prior 5-bar range: 0=low, 100=high, >100=breakout up, <0=breakdown. */
  pos5barRangePct: number;
}

function pipSize(symbol: string): number {
  if (symbol === "XAU/USD") return 0.1; // gold pip = $0.10
  if (symbol.endsWith("/JPY")) return 0.01;
  return 0.0001;
}

function roundLevel(symbol: string, price: number): { round: number; distPips: number } {
  let step: number;
  if (symbol === "XAU/USD") step = 5; // $5 increments — practical round levels for gold
  else if (symbol.endsWith("/JPY")) step = 0.5; // 50-pip
  else step = 0.005; // 50-pip
  const round = Math.round(price / step) * step;
  const distPips = Math.abs(price - round) / pipSize(symbol);
  return { round, distPips };
}

function structuralFeatures(bars: Bar[], i: number, symbol: string, entryPrice: number, entryUtc: Date): StructuralFeatures {
  const start = Math.max(0, i - 23);
  const window = bars.slice(start, i + 1);
  const high24h = Math.max(...window.map((b) => b.high));
  const low24h = Math.min(...window.map((b) => b.low));
  const pos24hRange = high24h === low24h ? 50 : ((entryPrice - low24h) / (high24h - low24h)) * 100;
  const vwapMean = window.reduce((s, b) => s + (b.open + b.high + b.low + b.close) / 4, 0) / window.length;
  const vwapPxDiffPct = vwapMean === 0 ? 0 : ((entryPrice - vwapMean) / vwapMean) * 100;
  const round = roundLevel(symbol, entryPrice);
  const fiveBar = bars.slice(Math.max(0, i - 4), i + 1);
  const fiveLo = Math.min(...fiveBar.map((b) => b.low));
  const fiveHi = Math.max(...fiveBar.map((b) => b.high));
  const pos5 = fiveHi === fiveLo ? 50 : ((entryPrice - fiveLo) / (fiveHi - fiveLo)) * 100;
  const hour = entryUtc.getUTCHours();
  const min = entryUtc.getUTCMinutes();
  const totalMins = hour * 60 + min;
  const minsToLondon = (totalMins - 7 * 60 + 1440) % 1440;
  const minsToNy = (totalMins - 13 * 60 + 1440) % 1440;
  return {
    nearestRoundDistPips: Math.round(round.distPips * 10) / 10,
    roundLevel: round.round,
    atr14: Math.round(atr14(bars, i) * 100000) / 100000,
    atrPctile: atrPercentile(bars, i),
    pos24hRange: Math.round(pos24hRange),
    high24h,
    low24h,
    vwapPxDiffPct: Math.round(vwapPxDiffPct * 100) / 100,
    minsToLondon: Math.min(minsToLondon, 1440 - minsToLondon),
    minsToNy: Math.min(minsToNy, 1440 - minsToNy),
    pos5barRangePct: Math.round(pos5),
  };
}

interface InspectionRow {
  trade: Trade;
  entryBarIndex: number;
  entryBar: Bar;
  bars: Bar[];
  features: StructuralFeatures;
  primitives: ReturnType<typeof aligned>;
}

interface ExtendedContext {
  // 4h structure: 8 prior 4h bars + the entry's 4h bar
  bars4h: Bar[];
  entry4hIndex: number;
  // Last 5 daily bars
  dailyContext: Bar[];
  // Daily bias result + the SMA20 value at trade day
  dailyBias: string;
  dailySma20: number;
  // Prior day high / low (the day before trade day)
  priorDayHigh: number;
  priorDayLow: number;
  priorDayPosPct: number; // where entry sits in prior day's range, 0=low 100=high, <0 below, >100 above
  // 4h-range structure: highest high + lowest low across last 6 4h bars (24h)
  rangeHigh24h_4h: number;
  rangeLow24h_4h: number;
  // 4h equilibrium of that range; >50 = premium, <50 = discount
  pos4h24hRangePct: number;
  // 4h-trend tag from last 3 closes (rough)
  hh4h: number;
  ll4h: number;
}

function findBarIndexByDate(bars: Bar[], targetDate: string): number {
  let last = -1;
  for (let i = 0; i < bars.length; i++) {
    if (bars[i].date <= targetDate) last = i;
    else break;
  }
  return last;
}

function extendedContext(
  hourBars: Bar[],
  i: number,
  bars4h: Bar[],
  dailyBars: Bar[],
  entryPrice: number
): ExtendedContext {
  const entryHourDate = hourBars[i].date;
  // Find 4h bar that contains the entry hour
  const ent4hIdx = findBarIndexByDate(bars4h, entryHourDate);
  const window4h = bars4h.slice(Math.max(0, ent4hIdx - 8), ent4hIdx + 1);
  const last24h_4h = bars4h.slice(Math.max(0, ent4hIdx - 5), ent4hIdx + 1);
  const r24Hi = Math.max(...last24h_4h.map((b) => b.high));
  const r24Lo = Math.min(...last24h_4h.map((b) => b.low));
  const pos4h = r24Hi === r24Lo ? 50 : ((entryPrice - r24Lo) / (r24Hi - r24Lo)) * 100;
  // 4h HH/LL count over last 4 bars (rough trend tag)
  let hh = 0, ll = 0;
  for (let k = 1; k <= Math.min(4, window4h.length - 1); k++) {
    const cur = window4h[window4h.length - k];
    const prev = window4h[window4h.length - k - 1];
    if (cur.high > prev.high) hh++;
    if (cur.low < prev.low) ll++;
  }
  // Daily context
  const tradeDay = entryHourDate.slice(0, 10);
  let dEnd = 0;
  for (let k = 0; k < dailyBars.length; k++) {
    if (dailyBars[k].date.slice(0, 10) <= tradeDay) dEnd = k + 1;
    else break;
  }
  const dailySlice = dailyBars.slice(0, dEnd);
  const dailyCtx = dailyBars.slice(Math.max(0, dEnd - 5), dEnd);
  // SMA20 of daily closes
  let sma20 = 0;
  if (dailySlice.length >= 20) {
    const last20 = dailySlice.slice(-20);
    sma20 = last20.reduce((s, b) => s + b.close, 0) / 20;
  }
  const lastDailyClose = dailySlice[dailySlice.length - 1]?.close ?? 0;
  const biasResult = sma20 > 0
    ? (lastDailyClose > sma20 ? "bullish" : "bearish")
    : "n/a";
  const priorDay = dailySlice.length >= 2 ? dailySlice[dailySlice.length - 2] : { high: 0, low: 0, open: 0, close: 0, date: "", volume: 0 };
  const priorRange = priorDay.high - priorDay.low;
  const priorPos = priorRange === 0 ? 50 : ((entryPrice - priorDay.low) / priorRange) * 100;
  return {
    bars4h: window4h,
    entry4hIndex: ent4hIdx,
    dailyContext: dailyCtx,
    dailyBias: biasResult,
    dailySma20: Number(sma20.toFixed(5)),
    priorDayHigh: priorDay.high,
    priorDayLow: priorDay.low,
    priorDayPosPct: Math.round(priorPos),
    rangeHigh24h_4h: r24Hi,
    rangeLow24h_4h: r24Lo,
    pos4h24hRangePct: Math.round(pos4h),
    hh4h: hh,
    ll4h: ll,
  };
}

async function main() {
  const trades = loadTrades();
  console.log(`Loaded ${trades.length} trades.\n`);

  const bySymbol = new Map<string, Trade[]>();
  for (const t of trades) {
    const arr = bySymbol.get(t.appSymbol) ?? [];
    arr.push(t);
    bySymbol.set(t.appSymbol, arr);
  }

  const allRows: (InspectionRow & { ext: ExtendedContext })[] = [];
  for (const [symbol, sTrades] of bySymbol) {
    console.log(`Loading ${symbol} 1h+4h+1d corpora...`);
    const c1 = await loadCorpus("1h", symbol);
    const c4 = await loadCorpus("4h", symbol);
    const hourBars: Bar[] = c1.bars;
    const bars4h: Bar[] = c4.bars;
    const dailyBars: Bar[] = c4.dailyBars;
    console.log(`  ${hourBars.length} 1h, ${bars4h.length} 4h, ${dailyBars.length} 1d bars`);
    for (const t of sTrades) {
      const idx = findBarIndex(hourBars, t.openUtc.getTime());
      if (idx < 25) continue;
      const dir: "bullish" | "bearish" = t.type === "buy" ? "bullish" : "bearish";
      const prims = aligned(dir, hourBars, idx, dailyBars);
      const aligned_count = Object.values(prims).filter(Boolean).length;
      if (aligned_count !== 0) continue;
      const window = hourBars.slice(Math.max(0, idx - 10), Math.min(hourBars.length, idx + 11));
      const feats = structuralFeatures(hourBars, idx, symbol, t.openPrice, t.openUtc);
      const ext = extendedContext(hourBars, idx, bars4h, dailyBars, t.openPrice);
      allRows.push({
        trade: t,
        entryBarIndex: idx,
        entryBar: hourBars[idx],
        bars: window,
        features: feats,
        primitives: prims,
        ext,
      });
    }
  }

  console.log(`\n\n=== ${allRows.length} ZERO-primitive trades — RIGOROUS STRUCTURAL READ ===\n`);
  for (const r of allRows) {
    const t = r.trade;
    const f = r.features;
    const x = r.ext;
    const dir = t.type === "buy" ? "LONG" : "SHORT";
    const outcome = t.isWin ? "WIN" : "LOSS";
    console.log(`\n=========== ${t.openUtc.toISOString().slice(0, 16)} UTC | ${t.appSymbol} ${dir} | ${outcome} ($${t.profit.toFixed(0)}) | dur=${Math.round(t.durationSec / 60)}min ===========`);
    console.log(`entry price: ${t.openPrice}  |  1h bar: O=${r.entryBar.open} H=${r.entryBar.high} L=${r.entryBar.low} C=${r.entryBar.close}`);
    console.log(`\nHTF context (this is where ICT signal would live):`);
    console.log(`  D1 bias: ${x.dailyBias} (SMA20=${x.dailySma20}, last close=${x.dailyContext[x.dailyContext.length - 1]?.close})`);
    console.log(`  Prior day: H=${x.priorDayHigh} L=${x.priorDayLow}  |  entry @ ${t.openPrice} = ${x.priorDayPosPct}% of prior-day range (>100=above pdh, <0=below pdl)`);
    console.log(`  4h 24h range: H=${x.rangeHigh24h_4h} L=${x.rangeLow24h_4h}  |  entry @ ${x.pos4h24hRangePct}% (>=50=premium, <50=discount)`);
    console.log(`  4h structure last 4 bars: ${x.hh4h} higher-highs, ${x.ll4h} lower-lows`);
    console.log(`  Last 5 daily bars:`);
    for (const b of x.dailyContext) {
      console.log(`    ${b.date.slice(0, 10)}  O=${b.open} H=${b.high} L=${b.low} C=${b.close}`);
    }
    console.log(`  Last 9 4h bars (entry's 4h bar = last):`);
    for (let bi = 0; bi < x.bars4h.length; bi++) {
      const b = x.bars4h[bi];
      const tag = bi === x.bars4h.length - 1 ? "  4h-ENTRY " : "           ";
      console.log(`    ${tag} ${b.date}  O=${b.open}  H=${b.high}  L=${b.low}  C=${b.close}`);
    }
    console.log(`\nMicro context (1h):`);
    console.log(`  round level: ${f.roundLevel} (${f.nearestRoundDistPips} pips away)`);
    console.log(`  ATR14=${f.atr14}, ATR pctile=${f.atrPctile}, pos in 24h range: ${f.pos24hRange}% [${f.low24h}..${f.high24h}]`);
    console.log(`  vs 24h vwap: ${f.vwapPxDiffPct >= 0 ? "+" : ""}${f.vwapPxDiffPct}%, pos prior-5bar: ${f.pos5barRangePct}%`);
    console.log(`  mins to London open: ${f.minsToLondon},  mins to NY open: ${f.minsToNy}`);
    console.log(`\n1h bars ±10 around entry:`);
    const entryWindowIdx = r.bars.findIndex((b) => b.date === r.entryBar.date);
    for (let bi = 0; bi < r.bars.length; bi++) {
      const b = r.bars[bi];
      const tag = bi === entryWindowIdx ? "ENTRY  " : "       ";
      console.log(`    ${tag} ${b.date}  O=${b.open}  H=${b.high}  L=${b.low}  C=${b.close}`);
    }
    console.log(`\nPrimitives that fired (in trade direction): NONE — that's the whole point of this subset.`);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outPath = `scripts/inspect-blind-spot-trades-${stamp}.json`;
  writeFileSync(outPath, JSON.stringify({ rows: allRows.map((r) => ({ ...r, bars: r.bars })) }, null, 2));
  console.log(`Saved: ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
