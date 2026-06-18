/**
 * Three follow-up analyses on backtest_trades data:
 *
 * A. Within 80-100% bucket (entry near ceiling): does vol_proxy=high
 *    correlate with higher TP hit rate? Tests Option C catalyst-exception
 *    hypothesis empirically.
 *
 * B. For TP-hit trades in 80-100% bucket: where did exit_price land
 *    relative to N-month rolling high? Did they break through or stop
 *    just below?
 *
 * C. Per-algo breakdown of the 60-80% "disaster zone" (lowest TP hit
 *    rate). Which algos are losing most there?
 */
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import { timeframeToInterval } from "../src/lib/market-data/interval";
import type { PriceBar } from "../src/lib/market-data/types";

{
  try {
    const raw = readFileSync(".env.local", "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (!m) continue;
      const [, k, v] = m;
      if (!process.env[k]) process.env[k] = v.replace(/^['"]|['"]$/g, "");
    }
  } catch {}
}

const ROLLING_MONTHS = 24;
const ATR_PERIOD = 14;
const VOL_LOOKBACK_BARS = 200;

interface TradeRow {
  algo_name: string;
  ticker: string;
  side: "long" | "short";
  entry_date: string;
  exit_date: string;
  entry_price: number;
  exit_price: number;
  exit_reason: string | null;
  timeframe: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getBarsNoTtl(supabase: any, ticker: string, interval: string): Promise<PriceBar[] | null> {
  const { data } = await supabase
    .from("price_cache")
    .select("bars")
    .eq("ticker", ticker.toUpperCase())
    .eq("output_size", "full")
    .eq("interval", interval)
    .limit(1)
    .single();
  return (data as { bars: PriceBar[] } | null)?.bars ?? null;
}

function trueRange(bar: PriceBar, prevClose: number): number {
  return Math.max(
    bar.high - bar.low,
    Math.abs(bar.high - prevClose),
    Math.abs(bar.low - prevClose)
  );
}

function atr14At(bars: PriceBar[], idx: number): number | null {
  if (idx < ATR_PERIOD) return null;
  let sum = 0;
  for (let i = idx - ATR_PERIOD + 1; i <= idx; i++) {
    sum += trueRange(bars[i], bars[i - 1].close);
  }
  return sum / ATR_PERIOD;
}

function findBarIdx(bars: PriceBar[], date: string): number {
  // Binary search for last bar with bar.date ≤ date
  const target = new Date(date).getTime();
  let lo = 0, hi = bars.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (new Date(bars[mid].date).getTime() <= target) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

function rollingExtreme(bars: PriceBar[], endDate: string, monthsBack: number): { high: number; low: number } | null {
  const endMs = new Date(endDate).getTime();
  const startMs = endMs - monthsBack * 30 * 24 * 60 * 60 * 1000;
  let high = -Infinity, low = Infinity;
  let hits = 0;
  for (const b of bars) {
    const t = new Date(b.date).getTime();
    if (t < startMs) continue;
    if (t >= endMs) break;
    if (b.high > high) high = b.high;
    if (b.low < low) low = b.low;
    hits++;
  }
  if (hits < 30) return null;
  return { high, low };
}

function volProxyAt(bars: PriceBar[], idx: number): "high" | "normal" | "low" | null {
  const currentAtr = atr14At(bars, idx);
  if (currentAtr == null) return null;
  const samples: number[] = [];
  const start = Math.max(ATR_PERIOD, idx - VOL_LOOKBACK_BARS);
  for (let j = start; j < idx; j++) {
    const v = atr14At(bars, j);
    if (v != null) samples.push(v);
  }
  if (samples.length < 50) return null;
  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)];
  if (median <= 0) return null;
  const ratio = currentAtr / median;
  if (ratio > 1.5) return "high";
  if (ratio < 0.75) return "low";
  return "normal";
}

async function main(): Promise<void> {
  console.log(`\n===== Backtest pattern follow-up analyses @ ${new Date().toISOString().slice(0, 16)} =====\n`);
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const supabase = createClient(url, key, { auth: { persistSession: false } });

  const tradesRes = await supabase
    .from("backtest_trades")
    .select("algorithm_id, ticker, side, entry_date, exit_date, entry_price, exit_price, exit_reason");
  if (tradesRes.error) { console.error(tradesRes.error.message); process.exit(1); }
  const algosRes = await supabase.from("algorithms").select("id, name, rules");
  const algoMap = new Map<string, { name: string; timeframe: string }>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const a of (algosRes.data ?? []) as any[]) {
    algoMap.set(a.id, { name: a.name, timeframe: a.rules?.timeframe ?? "4h" });
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const trades: TradeRow[] = ((tradesRes.data ?? []) as any[]).map((t) => {
    const meta = algoMap.get(t.algorithm_id);
    return {
      algo_name: meta?.name ?? "?",
      ticker: (t.ticker ?? "").toUpperCase(),
      side: t.side,
      entry_date: t.entry_date,
      exit_date: t.exit_date,
      entry_price: Number(t.entry_price),
      exit_price: Number(t.exit_price),
      exit_reason: t.exit_reason ?? null,
      timeframe: meta?.timeframe ?? "4h",
    };
  });

  const tickersUsed = [...new Set(trades.map((t) => t.ticker))];
  const barCaches = new Map<string, Map<string, PriceBar[]>>();
  for (const ticker of tickersUsed) {
    const tfMap = new Map<string, PriceBar[]>();
    for (const tf of ["4h", "1h", "30min", "1day"]) {
      const bars = await getBarsNoTtl(supabase, ticker, tf);
      if (bars) tfMap.set(tf, bars);
    }
    barCaches.set(ticker, tfMap);
  }

  // Enrich each trade with bucket + vol_proxy + rolling_high
  interface EnrichedTrade extends TradeRow {
    bucket: string;
    vol_proxy: "high" | "normal" | "low" | "unknown";
    rolling_high: number;
    rolling_low: number;
    exit_above_high_pct: number | null;
  }
  const enriched: EnrichedTrade[] = [];
  for (const t of trades) {
    const tfMap = barCaches.get(t.ticker);
    if (!tfMap) continue;
    const interval = timeframeToInterval(t.timeframe);
    const bars = tfMap.get(interval) ?? tfMap.get("4h");
    if (!bars) continue;
    const ext = rollingExtreme(bars, t.entry_date, ROLLING_MONTHS);
    if (!ext) continue;
    if (ext.high - ext.low <= 0) continue;
    const posLong = (t.entry_price - ext.low) / (ext.high - ext.low);
    const pos = t.side === "long" ? posLong : 1 - posLong;
    const bucket =
      pos < 0.2 ? "0-20"
      : pos < 0.4 ? "20-40"
      : pos < 0.6 ? "40-60"
      : pos < 0.8 ? "60-80"
      : "80-100";
    const entryIdx = findBarIdx(bars, t.entry_date);
    const vol = entryIdx >= 0 ? (volProxyAt(bars, entryIdx) ?? "unknown") : "unknown";
    // Exit position above/below rolling high (for longs) or below low (shorts)
    let exitAboveHighPct: number | null = null;
    if (t.side === "long") {
      exitAboveHighPct = (t.exit_price - ext.high) / ext.high * 100;
    } else {
      exitAboveHighPct = (ext.low - t.exit_price) / ext.low * 100;
    }
    enriched.push({ ...t, bucket, vol_proxy: vol, rolling_high: ext.high, rolling_low: ext.low, exit_above_high_pct: exitAboveHighPct });
  }

  console.log(`Enriched ${enriched.length} trades.\n`);

  // ----- Analysis A: 80-100% bucket vol_proxy vs TP hit rate -----
  console.log(`${"=".repeat(110)}`);
  console.log(`A. 80-100% bucket — does vol_proxy=high correlate with higher TP hit rate?`);
  console.log(`${"=".repeat(110)}\n`);
  const nearCeiling = enriched.filter((t) => t.bucket === "80-100");
  console.log(`Trades in 80-100% bucket: ${nearCeiling.length}\n`);
  const volBuckets: Record<string, { n: number; tp: number; sl: number; stag: number; sig: number }> = {
    high: { n: 0, tp: 0, sl: 0, stag: 0, sig: 0 },
    normal: { n: 0, tp: 0, sl: 0, stag: 0, sig: 0 },
    low: { n: 0, tp: 0, sl: 0, stag: 0, sig: 0 },
    unknown: { n: 0, tp: 0, sl: 0, stag: 0, sig: 0 },
  };
  for (const t of nearCeiling) {
    const b = volBuckets[t.vol_proxy];
    b.n++;
    const r = t.exit_reason ?? "";
    if (r.includes("take_profit")) b.tp++;
    else if (r.includes("stop_loss")) b.sl++;
    else if (r === "stagnant_exit") b.stag++;
    else if (r === "signal_exit") b.sig++;
  }
  console.log(`${"VOL_PROXY".padEnd(12)} ${"n".padStart(5)} ${"TP%".padStart(7)} ${"SL%".padStart(7)} ${"STAG%".padStart(7)} ${"SIG%".padStart(7)}`);
  for (const k of ["high", "normal", "low", "unknown"]) {
    const b = volBuckets[k];
    if (b.n === 0) continue;
    console.log(`${k.padEnd(12)} ${b.n.toString().padStart(5)} ${(b.tp / b.n * 100).toFixed(1).padStart(6)}% ${(b.sl / b.n * 100).toFixed(1).padStart(6)}% ${(b.stag / b.n * 100).toFixed(1).padStart(6)}% ${(b.sig / b.n * 100).toFixed(1).padStart(6)}%`);
  }
  const highTp = volBuckets.high.n > 0 ? volBuckets.high.tp / volBuckets.high.n * 100 : 0;
  const lowTp = volBuckets.low.n > 0 ? volBuckets.low.tp / volBuckets.low.n * 100 : 0;
  const normTp = volBuckets.normal.n > 0 ? volBuckets.normal.tp / volBuckets.normal.n * 100 : 0;
  console.log(`\nInterpretation:`);
  if (highTp > normTp + 5) console.log(`  ✓ vol_proxy=high TP rate is materially HIGHER than normal → Option C catalyst exception VALIDATED for this data.`);
  else if (highTp < normTp - 5) console.log(`  ✗ vol_proxy=high TP rate is materially LOWER than normal → Option C catalyst exception NOT supported (would refuse high-vol entries that fail).`);
  else console.log(`  ~ vol_proxy=high TP rate is similar to normal → Option C catalyst exception adds little signal.`);

  // ----- Analysis B: TP-hit trades in 80-100% — where did exit land? -----
  console.log(`\n${"=".repeat(110)}`);
  console.log(`B. TP-hit trades in 80-100% bucket — where did exit_price land relative to rolling high?`);
  console.log(`${"=".repeat(110)}\n`);
  const tpHits80100 = nearCeiling.filter((t) => (t.exit_reason ?? "").includes("take_profit"));
  console.log(`TP-hit trades in 80-100% bucket: ${tpHits80100.length}\n`);
  const exitBuckets = {
    "well below high (<-2%)": 0,
    "-2% to -0.5%": 0,
    "right at high (-0.5% to +0.5%)": 0,
    "above high (+0.5% to +2%)": 0,
    "well above high (>+2%)": 0,
  };
  for (const t of tpHits80100) {
    if (t.exit_above_high_pct == null) continue;
    const p = t.exit_above_high_pct;
    if (p < -2) exitBuckets["well below high (<-2%)"]++;
    else if (p < -0.5) exitBuckets["-2% to -0.5%"]++;
    else if (p < 0.5) exitBuckets["right at high (-0.5% to +0.5%)"]++;
    else if (p < 2) exitBuckets["above high (+0.5% to +2%)"]++;
    else exitBuckets["well above high (>+2%)"]++;
  }
  console.log(`${"EXIT ZONE".padEnd(40)} ${"count".padStart(6)} ${"% of TP hits".padStart(14)}`);
  for (const [zone, n] of Object.entries(exitBuckets)) {
    const pct = tpHits80100.length > 0 ? (n / tpHits80100.length * 100).toFixed(1) : "0.0";
    console.log(`${zone.padEnd(40)} ${n.toString().padStart(6)} ${pct.padStart(13)}%`);
  }
  const aboveHigh = exitBuckets["above high (+0.5% to +2%)"] + exitBuckets["well above high (>+2%)"];
  const aboveHighPct = tpHits80100.length > 0 ? aboveHigh / tpHits80100.length * 100 : 0;
  console.log(`\nInterpretation:`);
  console.log(`  ${aboveHighPct.toFixed(0)}% of TP hits in 80-100% bucket exited ABOVE rolling high — these were genuine breakouts.`);
  console.log(`  ${(100 - aboveHighPct).toFixed(0)}% exited at/below rolling high — TP target was within range.`);

  // ----- Analysis C: 60-80% bucket per-algo breakdown -----
  console.log(`\n${"=".repeat(110)}`);
  console.log(`C. 60-80% bucket "disaster zone" — per-algo breakdown`);
  console.log(`${"=".repeat(110)}\n`);
  const approachZone = enriched.filter((t) => t.bucket === "60-80");
  const perAlgo = new Map<string, { n: number; tp: number; sl: number }>();
  for (const t of approachZone) {
    if (!perAlgo.has(t.algo_name)) perAlgo.set(t.algo_name, { n: 0, tp: 0, sl: 0 });
    const b = perAlgo.get(t.algo_name)!;
    b.n++;
    const r = t.exit_reason ?? "";
    if (r.includes("take_profit")) b.tp++;
    else if (r.includes("stop_loss")) b.sl++;
  }
  const sorted = [...perAlgo.entries()]
    .filter(([, s]) => s.n >= 5)  // skip thin samples
    .sort((a, b) => (a[1].tp / a[1].n) - (b[1].tp / b[1].n));
  console.log(`${"ALGO".padEnd(50)} ${"n".padStart(5)} ${"TP%".padStart(7)} ${"SL%".padStart(7)}`);
  for (const [name, s] of sorted) {
    console.log(`${name.padEnd(50)} ${s.n.toString().padStart(5)} ${(s.tp / s.n * 100).toFixed(1).padStart(6)}% ${(s.sl / s.n * 100).toFixed(1).padStart(6)}%`);
  }
  console.log(`\nAlgos with ≥5 trades in 60-80% bucket, sorted by TP hit rate (worst first).`);
}

void main();
