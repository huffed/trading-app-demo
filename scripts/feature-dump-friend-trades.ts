/**
 * Feature dump per friend-trade entry. For every trade, capture a row
 * of context features at the entry bar across 1h + 1d, then compare
 * win vs loss distributions to find what discriminates his profitable
 * entries.
 *
 * The earlier template-replay showed our pattern detectors are
 * anti-correlated with his real edge. Either he's reading patterns we
 * don't have or his entries are momentum/level-driven in a way patterns
 * miss. This dump lets us look at the same trades through a wider lens
 * — distance to recent extremes, ATR percentile, position in range,
 * session, recent impulse — and see which features actually separate
 * his wins from losses.
 *
 * Output: pretty-printed comparison table + CSV `friend-features.csv`
 * for spreadsheet exploration.
 *
 * Run: npx tsx scripts/feature-dump-friend-trades.ts
 */
import { readFileSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";
import { computeAtr } from "../src/lib/market-data/regime-filter";
import { fetchDailyPrices } from "../src/lib/market-data/prices";
import type { BarInterval } from "../src/lib/market-data/interval";
import type { PriceBar } from "../src/lib/market-data/types";

// Manual env loader.
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
  symbol: string;
  appSymbol: string;
  profit: number;
  isWin: boolean;
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
  const seen = new Set<string>();
  for (const f of files) {
    const text = readFileSync(join(dir, f), "utf8");
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    for (let i = 1; i < lines.length; i++) {
      const cells: string[] = [];
      let cur = "";
      let inQuote = false;
      for (const ch of lines[i]) {
        if (ch === '"') {
          inQuote = !inQuote;
          continue;
        }
        if (ch === "," && !inQuote) {
          cells.push(cur);
          cur = "";
          continue;
        }
        cur += ch;
      }
      cells.push(cur);
      if (cells.length < 14) continue;
      const [ticket, open, type, , symbol, , , , , , , , profit] = cells;
      if (!open || !type || !symbol || seen.has(ticket)) continue;
      seen.add(ticket);
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

function findBarIndex(bars: PriceBar[], targetMs: number): number {
  let last = -1;
  for (let i = 0; i < bars.length; i++) {
    const t = new Date(bars[i].date).getTime();
    if (Number.isFinite(t) && t <= targetMs) last = i;
    else break;
  }
  return last;
}

function sessionBucket(hourUtc: number): "asia" | "london" | "ny" | "off" {
  if (hourUtc >= 0 && hourUtc < 7) return "asia";
  if (hourUtc >= 7 && hourUtc < 13) return "london";
  if (hourUtc >= 13 && hourUtc < 21) return "ny";
  return "off";
}

interface Features {
  ticket: string;
  symbol: string;
  type: "buy" | "sell";
  win: number; // 1 / 0
  hour_utc: number;
  session: string;
  // Position in 20-bar 1h range
  range_pos_20: number; // 0 = at recent low, 1 = at recent high
  dist_high_atr: number; // ATR units to recent 20-bar high
  dist_low_atr: number;
  // Recent 1h impulse
  impulse_3bar_atr: number; // sum of last 3 bar bodies in ATR units (signed)
  impulse_1bar_atr: number;
  // Volatility regime
  atr_pct_200: number; // percentile of current ATR vs last 200 bars (0..1)
  // Daily bias direction
  d1_bias: "bullish" | "bearish" | "neutral";
  d1_bias_aligned: number; // 1 if d1_bias matches trade direction, 0 otherwise
  // Position vs prior day
  prior_day_pos: number; // 0..1, where 0 = at prior-day low, 1 = at prior-day high (clamped)
  /** True when entry is above prior-day high (longs) or below prior-day low (shorts). */
  beyond_prior_day_extreme: number;
}

function pctile(value: number, series: number[]): number {
  if (series.length === 0) return 0;
  const sorted = [...series].sort((a, b) => a - b);
  let count = 0;
  for (const v of sorted) if (v <= value) count++;
  return count / sorted.length;
}

function buildFeatures(
  trade: Trade,
  bars1h: PriceBar[],
  i1h: number,
  bars1d: PriceBar[],
  i1d: number
): Features | null {
  if (i1h < 20 || i1d < 20) return null;
  const bar = bars1h[i1h];

  // 20-bar range on 1h
  const window = bars1h.slice(i1h - 20, i1h);
  const recentHigh = Math.max(...window.map((b) => b.high));
  const recentLow = Math.min(...window.map((b) => b.low));
  const range = recentHigh - recentLow;
  const rangePos = range > 0 ? (bar.close - recentLow) / range : 0.5;

  // ATR on 1h (14-period)
  const atrSeries = computeAtr(bars1h.slice(0, i1h + 1), 14);
  const currentAtr = atrSeries[i1h] ?? null;
  if (!currentAtr) return null;
  const distHighAtr = (recentHigh - bar.close) / currentAtr;
  const distLowAtr = (bar.close - recentLow) / currentAtr;

  // Recent 1h impulse: sum of last 3 bar bodies in ATR units
  const last3 = bars1h.slice(i1h - 2, i1h + 1);
  const impulse3 = last3.reduce((sum, b) => sum + (b.close - b.open), 0) / currentAtr;
  const impulse1 = (bar.close - bar.open) / currentAtr;

  // ATR percentile vs prior 200 bars
  const lookback = 200;
  const start = Math.max(15, i1h - lookback);
  const atrHistory: number[] = [];
  for (let k = start; k < i1h; k++) {
    const v = atrSeries[k];
    if (v != null) atrHistory.push(v);
  }
  const atrPct = pctile(currentAtr, atrHistory);

  // Daily bias: close vs SMA(20) on 1d
  const last20d = bars1d.slice(i1d - 19, i1d + 1);
  const sma20d = last20d.reduce((s, b) => s + b.close, 0) / last20d.length;
  const d1Close = bars1d[i1d].close;
  const d1Bias: "bullish" | "bearish" | "neutral" =
    d1Close > sma20d * 1.001 ? "bullish" : d1Close < sma20d * 0.999 ? "bearish" : "neutral";
  const tradeDir = trade.type === "buy" ? "bullish" : "bearish";
  const d1Aligned = d1Bias === tradeDir ? 1 : 0;

  // Prior day position
  const priorDay = bars1d[i1d - 1];
  const pdRange = priorDay.high - priorDay.low;
  const pdPos = pdRange > 0 ? (bar.close - priorDay.low) / pdRange : 0.5;
  const beyondPd =
    (trade.type === "buy" && bar.close > priorDay.high) ||
    (trade.type === "sell" && bar.close < priorDay.low)
      ? 1
      : 0;

  const hour = trade.openUtc.getUTCHours();

  return {
    ticket: trade.ticket,
    symbol: trade.appSymbol,
    type: trade.type,
    win: trade.isWin ? 1 : 0,
    hour_utc: hour,
    session: sessionBucket(hour),
    range_pos_20: Number(rangePos.toFixed(3)),
    dist_high_atr: Number(distHighAtr.toFixed(3)),
    dist_low_atr: Number(distLowAtr.toFixed(3)),
    impulse_3bar_atr: Number(impulse3.toFixed(3)),
    impulse_1bar_atr: Number(impulse1.toFixed(3)),
    atr_pct_200: Number(atrPct.toFixed(3)),
    d1_bias: d1Bias,
    d1_bias_aligned: d1Aligned,
    prior_day_pos: Number(pdPos.toFixed(3)),
    beyond_prior_day_extreme: beyondPd,
  };
}

function median(arr: number[]): number {
  if (arr.length === 0) return NaN;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function compareFeature(name: string, wins: number[], losses: number[]): string {
  const wMed = median(wins);
  const lMed = median(losses);
  const wMean = wins.length ? wins.reduce((a, b) => a + b, 0) / wins.length : NaN;
  const lMean = losses.length ? losses.reduce((a, b) => a + b, 0) / losses.length : NaN;
  const delta = wMed - lMed;
  const flag = Math.abs(delta) > 0.3 ? " ★" : "";
  return `${name.padEnd(26)}  win med=${wMed.toFixed(2).padStart(6)}  loss med=${lMed.toFixed(2).padStart(6)}  Δ=${delta.toFixed(2).padStart(6)}  win mean=${wMean.toFixed(2).padStart(6)}  loss mean=${lMean.toFixed(2).padStart(6)}${flag}`;
}

async function main() {
  const trades = loadTrades();
  console.log(`Loaded ${trades.length} unique trades.`);

  const symbols = Array.from(new Set(trades.map((t) => t.appSymbol)));
  const intervals: BarInterval[] = ["1day", "1h"];

  console.log(`\nFetching bars for ${symbols.length} symbols × ${intervals.length} intervals...`);
  const symBars = new Map<string, Map<BarInterval, PriceBar[]>>();
  for (const symbol of symbols) {
    const map = new Map<BarInterval, PriceBar[]>();
    symBars.set(symbol, map);
    for (const iv of intervals) {
      try {
        const bars = await fetchDailyPrices(symbol, "full", iv);
        map.set(iv, bars);
        console.log(`  ${symbol} ${iv}: ${bars.length} bars`);
      } catch (err) {
        console.log(`  ${symbol} ${iv}: FAIL (${(err as Error).message})`);
      }
    }
  }

  const features: Features[] = [];
  for (const trade of trades) {
    const sb = symBars.get(trade.appSymbol);
    if (!sb) continue;
    const bars1h = sb.get("1h");
    const bars1d = sb.get("1day");
    if (!bars1h || !bars1d) continue;
    const ms = trade.openUtc.getTime();
    const i1h = findBarIndex(bars1h, ms);
    const i1d = findBarIndex(bars1d, ms);
    if (i1h < 20 || i1d < 20) continue;
    const f = buildFeatures(trade, bars1h, i1h, bars1d, i1d);
    if (f) features.push(f);
  }

  console.log(`\nFeatures built for ${features.length} / ${trades.length} trades.`);

  // Win/loss splits
  const wins = features.filter((f) => f.win === 1);
  const losses = features.filter((f) => f.win === 0);
  console.log(`  wins: ${wins.length}, losses: ${losses.length}\n`);

  const NUMERIC_FEATURES = [
    "range_pos_20",
    "dist_high_atr",
    "dist_low_atr",
    "impulse_3bar_atr",
    "impulse_1bar_atr",
    "atr_pct_200",
    "d1_bias_aligned",
    "prior_day_pos",
    "beyond_prior_day_extreme",
    "hour_utc",
  ] as const;

  console.log("=== Numeric feature comparison: win vs loss median (Δ ≥ 0.3 flagged) ===\n");
  for (const name of NUMERIC_FEATURES) {
    const w = wins.map((f) => f[name] as number);
    const l = losses.map((f) => f[name] as number);
    console.log(compareFeature(name, w, l));
  }

  // Directional split — earlier replay showed the pullback signal is
  // possibly asymmetric (works for longs but not shorts). If long wins
  // have negative impulse but short wins also have negative impulse,
  // the signal is just "bearish bias" not "pullback into trend".
  const longWins = features.filter((f) => f.type === "buy" && f.win === 1);
  const longLosses = features.filter((f) => f.type === "buy" && f.win === 0);
  const shortWins = features.filter((f) => f.type === "sell" && f.win === 1);
  const shortLosses = features.filter((f) => f.type === "sell" && f.win === 0);

  console.log(
    `\n=== LONG-only feature comparison (${longWins.length} wins, ${longLosses.length} losses) ===\n`
  );
  for (const name of NUMERIC_FEATURES) {
    const w = longWins.map((f) => f[name] as number);
    const l = longLosses.map((f) => f[name] as number);
    console.log(compareFeature(name, w, l));
  }

  console.log(
    `\n=== SHORT-only feature comparison (${shortWins.length} wins, ${shortLosses.length} losses) ===\n`
  );
  for (const name of NUMERIC_FEATURES) {
    const w = shortWins.map((f) => f[name] as number);
    const l = shortLosses.map((f) => f[name] as number);
    console.log(compareFeature(name, w, l));
  }

  console.log("\n=== Categorical: session distribution ===");
  const sessionWins: Record<string, number> = {};
  const sessionLosses: Record<string, number> = {};
  for (const f of wins) sessionWins[f.session] = (sessionWins[f.session] ?? 0) + 1;
  for (const f of losses) sessionLosses[f.session] = (sessionLosses[f.session] ?? 0) + 1;
  const allSessions = new Set([...Object.keys(sessionWins), ...Object.keys(sessionLosses)]);
  for (const s of allSessions) {
    const w = sessionWins[s] ?? 0;
    const l = sessionLosses[s] ?? 0;
    const total = w + l;
    const wr = total > 0 ? (w / total) * 100 : 0;
    console.log(`  ${s.padEnd(8)}  win=${String(w).padStart(2)}  loss=${String(l).padStart(2)}  WR=${wr.toFixed(0)}%`);
  }

  console.log("\n=== Categorical: d1_bias distribution ===");
  const biasWins: Record<string, number> = {};
  const biasLosses: Record<string, number> = {};
  for (const f of wins) biasWins[f.d1_bias] = (biasWins[f.d1_bias] ?? 0) + 1;
  for (const f of losses) biasLosses[f.d1_bias] = (biasLosses[f.d1_bias] ?? 0) + 1;
  const allBiases = new Set([...Object.keys(biasWins), ...Object.keys(biasLosses)]);
  for (const b of allBiases) {
    const w = biasWins[b] ?? 0;
    const l = biasLosses[b] ?? 0;
    const total = w + l;
    const wr = total > 0 ? (w / total) * 100 : 0;
    console.log(`  ${b.padEnd(10)}  win=${String(w).padStart(2)}  loss=${String(l).padStart(2)}  WR=${wr.toFixed(0)}%`);
  }

  // CSV dump for manual exploration
  const headers = Object.keys(features[0] ?? {});
  const csv = [
    headers.join(","),
    ...features.map((f) =>
      headers.map((h) => String((f as unknown as Record<string, unknown>)[h])).join(",")
    ),
  ].join("\n");
  writeFileSync("friend-features.csv", csv);
  console.log(`\nCSV written: friend-features.csv (${features.length} rows)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
