/**
 * Multi-timeframe replay of the friend's actual FTMO trades.
 *
 * He told us he varies between 5m and 15m for entries, with higher
 * timeframes (1h / 4h) for context. Single-TF replays we ran earlier
 * couldn't match this — the 1h replay caught only 5% of his entries
 * via our 2-of-3 pattern gate. This script tests the multi-TF
 * hypothesis: does his entry timing line up with patterns firing at
 * MULTIPLE timeframes simultaneously?
 *
 * For each trade, fetches 4h + 1h + 15m + 1d bars and evaluates our
 * pattern detectors at the bar nearest his entry timestamp at each
 * timeframe. Reports per-pattern hit rate per TF, plus
 * "≥ N timeframes agreeing" rate.
 *
 * Twelve Data 15m caps at 5000 bars ≈ 52 days, so trades older than
 * that fall through with `15m: no data`. Most useful for the second
 * half of his trade window (March 2026 onwards).
 *
 * Run: npx tsx scripts/multi-tf-friend-replay.ts
 */
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { detectBos } from "../src/lib/patterns/bos";
import { detectDailyBias } from "../src/lib/patterns/daily-bias";
import { detectFvg } from "../src/lib/patterns/fvg";
import { detectLiquiditySweep } from "../src/lib/patterns/liquidity-sweep";
import { detectOrderBlock } from "../src/lib/patterns/order-block";

// Manual env loader
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
const TIMEFRAMES = ["15min", "1h", "4h"] as const;
type Timeframe = (typeof TIMEFRAMES)[number] | "1day";

interface Trade {
  ticket: string;
  openUtc: Date;
  type: "buy" | "sell";
  symbol: string;
  appSymbol: string;
  profit: number;
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
      const [ticket, open, type, , symbol, , , , , , , , profit] = cells;
      if (!open || !type || !symbol) continue;
      const profitNum = Number(profit);
      out.push({
        ticket,
        openUtc: brokerTimestampToUtc(open),
        type: type as "buy" | "sell",
        symbol,
        appSymbol: mt5ToAppSymbol(symbol),
        profit: profitNum,
        isWin: profitNum > 0,
      });
    }
  }
  return out.sort((a, b) => a.openUtc.getTime() - b.openUtc.getTime());
}

async function fetchBars(symbol: string, interval: Timeframe): Promise<Bar[]> {
  const apiKey = process.env.TWELVE_DATA_API_KEY;
  if (!apiKey) throw new Error("TWELVE_DATA_API_KEY missing");
  const size = interval === "1day" ? 200 : 5000;
  const url =
    `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}` +
    `&interval=${interval}&outputsize=${size}&apikey=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Twelve Data ${res.status} for ${symbol} ${interval}`);
  const data: { values?: Array<{
    datetime: string; open: string; high: string; low: string; close: string; volume?: string;
  }>; status?: string; message?: string } = await res.json();
  if (data.status === "error") throw new Error(`${data.message}`);
  if (!data.values?.length) return [];
  return data.values
    .map((v) => ({
      date: v.datetime,
      open: parseFloat(v.open),
      high: parseFloat(v.high),
      low: parseFloat(v.low),
      close: parseFloat(v.close),
      volume: v.volume ? parseInt(v.volume) : 0,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
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

interface SignalSet {
  bias_bull: boolean;
  bias_bear: boolean;
  bos_bull: boolean;
  bos_bear: boolean;
  ob_bull: boolean;
  ob_bear: boolean;
  fvg_bull: boolean;
  fvg_bear: boolean;
  sweep_bull: boolean;
  sweep_bear: boolean;
  /** Engulfing candle (bullish or bearish). */
  engulfing_bull: boolean;
  engulfing_bear: boolean;
  /** Pin bar (long wick rejecting). */
  pin_bull: boolean;
  pin_bear: boolean;
}

function detectEngulfing(prev: Bar, cur: Bar): "bullish" | "bearish" | null {
  // Simple definition: current candle's body fully engulfs previous body and direction reverses.
  const prevBull = prev.close > prev.open;
  const curBull = cur.close > cur.open;
  if (prevBull === curBull) return null;
  if (curBull && cur.close > prev.open && cur.open < prev.close) return "bullish";
  if (!curBull && cur.close < prev.open && cur.open > prev.close) return "bearish";
  return null;
}

function detectPinBar(bar: Bar): "bullish" | "bearish" | null {
  // Long-wick rejection: wick on one side ≥ 2× body and opposite wick small.
  const body = Math.abs(bar.close - bar.open);
  const upperWick = bar.high - Math.max(bar.open, bar.close);
  const lowerWick = Math.min(bar.open, bar.close) - bar.low;
  if (body === 0) return null;
  if (lowerWick >= 2 * body && lowerWick > 2 * upperWick) return "bullish";
  if (upperWick >= 2 * body && upperWick > 2 * lowerWick) return "bearish";
  return null;
}

function evaluateSignals(
  bars: Bar[],
  i: number,
  dailyBars: Bar[]
): SignalSet | null {
  if (i < 5 || !bars[i]) return null;
  const tradeDay = bars[i].date.slice(0, 10);
  let dEnd = 0;
  for (let k = 0; k < dailyBars.length; k++) {
    if (dailyBars[k].date.slice(0, 10) <= tradeDay) dEnd = k + 1;
    else break;
  }
  const dailySlice = dailyBars.slice(0, dEnd);
  const bias = dailySlice.length >= 20 ? detectDailyBias(dailySlice, 20) : { detected: false };

  const bos = detectBos(bars, i, 5);
  const ob = detectOrderBlock(bars, i, { lookback: 5 });
  const fvg = detectFvg(bars, i);
  const sweep = detectLiquiditySweep(bars, i, 5);
  const engulf = i > 0 ? detectEngulfing(bars[i - 1], bars[i]) : null;
  const pin = detectPinBar(bars[i]);

  return {
    bias_bull: bias.detected && (bias as ReturnType<typeof detectDailyBias>).details?.bias === "bullish",
    bias_bear: bias.detected && (bias as ReturnType<typeof detectDailyBias>).details?.bias === "bearish",
    bos_bull: bos.detected && bos.details?.direction === "bullish",
    bos_bear: bos.detected && bos.details?.direction === "bearish",
    ob_bull: ob.detected && ob.details?.direction === "bullish",
    ob_bear: ob.detected && ob.details?.direction === "bearish",
    fvg_bull: fvg.detected && fvg.details?.direction === "bullish",
    fvg_bear: fvg.detected && fvg.details?.direction === "bearish",
    sweep_bull: sweep.detected && sweep.details?.direction === "bullish",
    sweep_bear: sweep.detected && sweep.details?.direction === "bearish",
    engulfing_bull: engulf === "bullish",
    engulfing_bear: engulf === "bearish",
    pin_bull: pin === "bullish",
    pin_bear: pin === "bearish",
  };
}

function alignedKeys(s: SignalSet, dir: "bullish" | "bearish"): string[] {
  const isBull = dir === "bullish";
  const out: string[] = [];
  if (isBull ? s.bias_bull : s.bias_bear) out.push("bias");
  if (isBull ? s.bos_bull : s.bos_bear) out.push("bos");
  if (isBull ? s.ob_bull : s.ob_bear) out.push("ob");
  if (isBull ? s.fvg_bull : s.fvg_bear) out.push("fvg");
  if (isBull ? s.sweep_bull : s.sweep_bear) out.push("sweep");
  if (isBull ? s.engulfing_bull : s.engulfing_bear) out.push("engulf");
  if (isBull ? s.pin_bull : s.pin_bear) out.push("pin");
  return out;
}

interface TradeReplay {
  trade: Trade;
  /** For each TF, the aligned signal keys (or null when bars aren't covered). */
  aligned: Partial<Record<Timeframe, string[]>>;
}

async function main() {
  const trades = loadTrades();
  console.log(`Loaded ${trades.length} trades.`);

  const bySymbol = new Map<string, Trade[]>();
  for (const t of trades) {
    const arr = bySymbol.get(t.appSymbol) ?? [];
    arr.push(t);
    bySymbol.set(t.appSymbol, arr);
  }

  // Twelve Data 8 credits/min cap. Each symbol fetches 4 TFs (15m, 1h,
  // 4h, 1d) = 4 credits per symbol, 12 total for 3 symbols. Just inside
  // a single minute — but if the cache is cold from earlier calls we
  // need to pause. Pause every 6 fetches.
  const symBars = new Map<string, Partial<Record<Timeframe, Bar[]>>>();
  let fetchCount = 0;
  for (const [symbol] of bySymbol) {
    console.log(`\nFetching ${symbol}...`);
    const tf: Partial<Record<Timeframe, Bar[]>> = {};
    for (const interval of [...TIMEFRAMES, "1day" as const]) {
      if (fetchCount > 0 && fetchCount % 6 === 0) {
        console.log("  rate-limit pause (60s)...");
        await new Promise((r) => setTimeout(r, 60_000));
      }
      try {
        tf[interval] = await fetchBars(symbol, interval);
        console.log(`  ${interval}: ${tf[interval]!.length} bars`);
      } catch (e) {
        console.log(`  ${interval}: skip — ${e instanceof Error ? e.message : e}`);
      }
      fetchCount++;
    }
    symBars.set(symbol, tf);
  }

  const replays: TradeReplay[] = [];
  for (const t of trades) {
    const tf = symBars.get(t.appSymbol);
    if (!tf) continue;
    const dailyBars = tf["1day"] ?? [];
    const dir: "bullish" | "bearish" = t.type === "buy" ? "bullish" : "bearish";
    const aligned: Partial<Record<Timeframe, string[]>> = {};
    for (const interval of TIMEFRAMES) {
      const bars = tf[interval];
      if (!bars) continue;
      const idx = findBarIndex(bars, t.openUtc.getTime());
      if (idx < 5) continue;
      const sig = evaluateSignals(bars, idx, dailyBars);
      if (!sig) continue;
      aligned[interval] = alignedKeys(sig, dir);
    }
    replays.push({ trade: t, aligned });
  }

  // Per-TF coverage
  console.log("\n=== Coverage ===");
  for (const interval of TIMEFRAMES) {
    const covered = replays.filter((r) => r.aligned[interval]).length;
    console.log(`  ${interval}: ${covered} / ${trades.length} trades covered`);
  }

  // Per-pattern per-TF hit rate (in trade direction)
  const PATTERNS = ["bias", "bos", "ob", "fvg", "sweep", "engulf", "pin"];
  console.log("\n=== Per-pattern hit rate (in trade direction) by TF ===");
  console.log("Pattern    " + TIMEFRAMES.map((tf) => tf.padStart(8)).join(""));
  for (const p of PATTERNS) {
    const cells = TIMEFRAMES.map((interval) => {
      const covered = replays.filter((r) => r.aligned[interval]);
      if (covered.length === 0) return "n/a".padStart(8);
      const fired = covered.filter((r) => r.aligned[interval]!.includes(p)).length;
      return `${((fired / covered.length) * 100).toFixed(0)}%`.padStart(8);
    });
    console.log(`${p.padEnd(11)}${cells.join("")}`);
  }

  // Multi-TF confluence: count how many TFs had ≥1 pattern firing per trade
  console.log("\n=== Multi-TF confluence (any pattern firing per TF, in trade direction) ===");
  for (const interval of TIMEFRAMES) {
    const covered = replays.filter((r) => r.aligned[interval]);
    const anyFired = covered.filter((r) => (r.aligned[interval]!.length ?? 0) > 0).length;
    const wins = covered.filter((r) => r.trade.isWin && (r.aligned[interval]!.length ?? 0) > 0).length;
    const losses = covered.filter((r) => !r.trade.isWin && (r.aligned[interval]!.length ?? 0) > 0).length;
    console.log(
      `  ${interval}: any-fire ${anyFired}/${covered.length} (${covered.length ? ((anyFired / covered.length) * 100).toFixed(0) : "0"}%)  ` +
        `wins ${wins} / losses ${losses}`
    );
  }

  // Confluence bucket: how many TFs (out of those covered) had ≥1 fire
  console.log("\n=== TF-agreement distribution (per trade — how many TFs agreed?) ===");
  const agreementCounts = new Map<number, { wins: number; losses: number }>();
  for (const r of replays) {
    let agreed = 0;
    for (const interval of TIMEFRAMES) {
      const list = r.aligned[interval];
      if (list && list.length > 0) agreed++;
    }
    const slot = agreementCounts.get(agreed) ?? { wins: 0, losses: 0 };
    if (r.trade.isWin) slot.wins++;
    else slot.losses++;
    agreementCounts.set(agreed, slot);
  }
  for (let n = 0; n <= TIMEFRAMES.length; n++) {
    const slot = agreementCounts.get(n);
    if (!slot) continue;
    const total = slot.wins + slot.losses;
    const wr = total > 0 ? (slot.wins / total) * 100 : 0;
    console.log(`  ${n} TF agreement: ${total} trades, WR ${wr.toFixed(1)}%`);
  }

  // Sample dump: per-trade
  console.log("\n=== Per-trade signal alignment (sample of first 15) ===");
  for (const r of replays.slice(0, 15)) {
    const tf15 = r.aligned["15min"]?.join("+") ?? "—";
    const tf1h = r.aligned["1h"]?.join("+") ?? "—";
    const tf4h = r.aligned["4h"]?.join("+") ?? "—";
    const t = r.trade;
    console.log(
      `  ${t.openUtc.toISOString().slice(0, 16)} ${t.symbol.padEnd(7)} ${t.type.padEnd(4)} ` +
        `${t.isWin ? "+$" + t.profit.toFixed(0).padStart(4) : "-$" + Math.abs(t.profit).toFixed(0).padStart(4)} | ` +
        `15m=${tf15.padEnd(20)} 1h=${tf1h.padEnd(20)} 4h=${tf4h}`
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
