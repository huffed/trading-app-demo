/**
 * Analyse backtest_trades for patterns that inform the TP structural-
 * ceiling design (Option A/B/C/Hybrid).
 *
 * Three analyses:
 *
 * 1. EXIT REASON DISTRIBUTION — per-algo + aggregate. What fraction of
 *    trades hit TP vs SL vs stagnant vs other?
 *
 * 2. POSITION-IN-RANGE vs HIT RATE — for each trade, compute the entry
 *    price's position in the 24-month rolling range. Bucket and report
 *    TP-hit-rate per bucket. Tests whether trades entered near recent
 *    highs/lows actually hit TP less often (operator's hypothesis).
 *
 * 3. R-MULTIPLE DISTRIBUTION — overall + by exit reason. Shows whether
 *    TP hits are full-R or partial.
 *
 * Caveat: backtest_trades data is from yesterday (pre engine bug fixes).
 * Patterns should still inform design; absolute numbers may shift after
 * Phase B re-validation.
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

interface TradeRow {
  algorithm_id: string;
  algo_name: string;
  ticker: string;
  side: "long" | "short";
  entry_date: string;
  exit_date: string;
  entry_price: number;
  exit_price: number;
  pnl: number;
  r_multiple: number | null;
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

interface BucketStats {
  bucket: string;
  n: number;
  tp_hits: number;
  sl_hits: number;
  stagnant: number;
  signal_exit: number;
  other: number;
  tp_hit_rate: number;
  mean_r: number;
}

function bucketByRangePosition(pos: number): string {
  if (pos < 0.20) return "0-20% (near low)";
  if (pos < 0.40) return "20-40%";
  if (pos < 0.60) return "40-60% (middle)";
  if (pos < 0.80) return "60-80%";
  return "80-100% (near high)";
}

async function main(): Promise<void> {
  console.log(`\n===== Backtest pattern analysis @ ${new Date().toISOString().slice(0, 16)} =====\n`);
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const supabase = createClient(url, key, { auth: { persistSession: false } });

  // Pull trades + algo metadata
  const tradesRes = await supabase
    .from("backtest_trades")
    .select("algorithm_id, ticker, side, entry_date, exit_date, entry_price, exit_price, pnl, r_multiple, exit_reason");
  if (tradesRes.error) { console.error(tradesRes.error.message); process.exit(1); }
  const algosRes = await supabase.from("algorithms").select("id, name, rules");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const algoMap = new Map<string, { name: string; timeframe: string }>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const a of (algosRes.data ?? []) as any[]) {
    algoMap.set(a.id, { name: a.name, timeframe: a.rules?.timeframe ?? "4h" });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const trades: TradeRow[] = ((tradesRes.data ?? []) as any[]).map((t) => {
    const meta = algoMap.get(t.algorithm_id);
    return {
      algorithm_id: t.algorithm_id,
      algo_name: meta?.name ?? "?",
      ticker: (t.ticker ?? "").toUpperCase(),
      side: t.side,
      entry_date: t.entry_date,
      exit_date: t.exit_date,
      entry_price: Number(t.entry_price),
      exit_price: Number(t.exit_price),
      pnl: Number(t.pnl),
      r_multiple: t.r_multiple != null ? Number(t.r_multiple) : null,
      exit_reason: t.exit_reason ?? null,
      timeframe: meta?.timeframe ?? "4h",
    };
  });

  console.log(`Loaded ${trades.length} trades across ${algoMap.size} algos.\n`);

  // ----- Analysis 1: Exit reason distribution -----
  console.log(`${"=".repeat(110)}\n1. EXIT REASON DISTRIBUTION\n${"=".repeat(110)}`);
  const overall = {
    n: 0, tp: 0, sl: 0, stagnant: 0, signal: 0, force: 0, null_: 0,
  };
  const perAlgo = new Map<string, typeof overall>();
  for (const t of trades) {
    overall.n++;
    if (!perAlgo.has(t.algo_name)) perAlgo.set(t.algo_name, { n: 0, tp: 0, sl: 0, stagnant: 0, signal: 0, force: 0, null_: 0 });
    const pa = perAlgo.get(t.algo_name)!;
    pa.n++;
    const r = t.exit_reason ?? "null";
    if (r.includes("take_profit") || r === "tp") { overall.tp++; pa.tp++; }
    else if (r.includes("stop_loss") || r === "sl") { overall.sl++; pa.sl++; }
    else if (r === "stagnant_exit") { overall.stagnant++; pa.stagnant++; }
    else if (r === "signal_exit") { overall.signal++; pa.signal++; }
    else if (r === "force_close") { overall.force++; pa.force++; }
    else { overall.null_++; pa.null_++; }
  }
  console.log(`\nOverall (${overall.n} trades):`);
  console.log(`  TP hit:        ${overall.tp.toString().padStart(5)} (${(overall.tp / overall.n * 100).toFixed(1)}%)`);
  console.log(`  SL hit:        ${overall.sl.toString().padStart(5)} (${(overall.sl / overall.n * 100).toFixed(1)}%)`);
  console.log(`  Stagnant exit: ${overall.stagnant.toString().padStart(5)} (${(overall.stagnant / overall.n * 100).toFixed(1)}%)`);
  console.log(`  Signal exit:   ${overall.signal.toString().padStart(5)} (${(overall.signal / overall.n * 100).toFixed(1)}%)`);
  console.log(`  Force close:   ${overall.force.toString().padStart(5)} (${(overall.force / overall.n * 100).toFixed(1)}%)`);
  console.log(`  Null/other:    ${overall.null_.toString().padStart(5)} (${(overall.null_ / overall.n * 100).toFixed(1)}%)`);

  console.log(`\nPer-algo (sorted by trade count):`);
  const algosByCount = [...perAlgo.entries()].sort((a, b) => b[1].n - a[1].n);
  console.log(`  ${"ALGO".padEnd(52)} ${"n".padStart(5)} ${"TP%".padStart(6)} ${"SL%".padStart(6)} ${"STAG%".padStart(6)} ${"SIG%".padStart(6)}`);
  for (const [name, s] of algosByCount) {
    console.log(`  ${name.padEnd(52)} ${s.n.toString().padStart(5)} ${(s.tp / s.n * 100).toFixed(1).padStart(5)}% ${(s.sl / s.n * 100).toFixed(1).padStart(5)}% ${(s.stagnant / s.n * 100).toFixed(1).padStart(5)}% ${(s.signal / s.n * 100).toFixed(1).padStart(5)}%`);
  }

  // ----- Analysis 2: Position in rolling range vs hit rate -----
  console.log(`\n${"=".repeat(110)}\n2. ENTRY POSITION IN ${ROLLING_MONTHS}-MONTH RANGE vs OUTCOME\n${"=".repeat(110)}`);
  console.log(`(For longs: 100% = at recent high. For shorts: position_in_range computed from inverse perspective.)\n`);

  const tickersUsed = [...new Set(trades.map((t) => t.ticker))];
  console.log(`Loading price caches for tickers: ${tickersUsed.join(", ")}`);
  const barCaches = new Map<string, Map<string, PriceBar[]>>();  // ticker -> tf -> bars
  for (const ticker of tickersUsed) {
    const tfMap = new Map<string, PriceBar[]>();
    for (const tf of ["4h", "1h", "30min", "1day"]) {
      const bars = await getBarsNoTtl(supabase, ticker, tf);
      if (bars) tfMap.set(tf, bars);
    }
    barCaches.set(ticker, tfMap);
  }

  const buckets = new Map<string, BucketStats>();
  let analyzed = 0, skipped = 0;
  for (const t of trades) {
    const tfMap = barCaches.get(t.ticker);
    if (!tfMap) { skipped++; continue; }
    const interval = timeframeToInterval(t.timeframe);
    const bars = tfMap.get(interval) ?? tfMap.get("4h");
    if (!bars) { skipped++; continue; }
    const extreme = rollingExtreme(bars, t.entry_date, ROLLING_MONTHS);
    if (!extreme) { skipped++; continue; }
    const { high, low } = extreme;
    if (high - low <= 0) { skipped++; continue; }

    // For longs: position_in_range = (entry - low) / (high - low). 100% = at high.
    // For shorts: we want "near short-side extreme" = near low. So invert.
    const posLong = (t.entry_price - low) / (high - low);
    const pos = t.side === "long" ? posLong : 1 - posLong;
    const bucket = bucketByRangePosition(pos);
    if (!buckets.has(bucket)) {
      buckets.set(bucket, { bucket, n: 0, tp_hits: 0, sl_hits: 0, stagnant: 0, signal_exit: 0, other: 0, tp_hit_rate: 0, mean_r: 0 });
    }
    const b = buckets.get(bucket)!;
    b.n++;
    const r = t.exit_reason ?? "null";
    if (r.includes("take_profit")) b.tp_hits++;
    else if (r.includes("stop_loss")) b.sl_hits++;
    else if (r === "stagnant_exit") b.stagnant++;
    else if (r === "signal_exit") b.signal_exit++;
    else b.other++;
    if (t.r_multiple != null) b.mean_r += t.r_multiple;
    analyzed++;
  }
  console.log(`Analyzed ${analyzed} trades / skipped ${skipped} (no bars or thin history).\n`);

  console.log(`${"BUCKET (entry side proximity)".padEnd(28)} ${"n".padStart(5)} ${"TP%".padStart(7)} ${"SL%".padStart(7)} ${"STAG%".padStart(7)} ${"mean_R".padStart(8)}`);
  const bucketOrder = ["0-20% (near low)", "20-40%", "40-60% (middle)", "60-80%", "80-100% (near high)"];
  for (const bn of bucketOrder) {
    const b = buckets.get(bn);
    if (!b) { console.log(`${bn.padEnd(28)} (no trades)`); continue; }
    b.tp_hit_rate = b.tp_hits / b.n * 100;
    b.mean_r = b.mean_r / b.n;
    console.log(`${b.bucket.padEnd(28)} ${b.n.toString().padStart(5)} ${b.tp_hit_rate.toFixed(1).padStart(6)}% ${(b.sl_hits / b.n * 100).toFixed(1).padStart(6)}% ${(b.stagnant / b.n * 100).toFixed(1).padStart(6)}% ${b.mean_r.toFixed(2).padStart(7)}`);
  }
  console.log(`\nInterpretation: For longs, "80-100% (near high)" = entries near multi-year ceiling.`);
  console.log(`If TP hit-rate drops moving toward "near high" → confirms operator's hypothesis.`);
  console.log(`Same logic for shorts (proximity to multi-year floor).`);

  // ----- Analysis 3: R-multiple distribution by exit reason -----
  console.log(`\n${"=".repeat(110)}\n3. R-MULTIPLE BY EXIT REASON\n${"=".repeat(110)}`);
  const byReason = new Map<string, { n: number; sum: number; sumSq: number }>();
  for (const t of trades) {
    if (t.r_multiple == null) continue;
    const r = t.exit_reason ?? "null";
    if (!byReason.has(r)) byReason.set(r, { n: 0, sum: 0, sumSq: 0 });
    const b = byReason.get(r)!;
    b.n++;
    b.sum += t.r_multiple;
    b.sumSq += t.r_multiple * t.r_multiple;
  }
  console.log(`${"EXIT REASON".padEnd(30)} ${"n".padStart(5)} ${"mean R".padStart(8)} ${"std R".padStart(8)}`);
  for (const [r, s] of [...byReason.entries()].sort((a, b) => b[1].n - a[1].n)) {
    const mean = s.sum / s.n;
    const variance = s.sumSq / s.n - mean * mean;
    const sd = Math.sqrt(Math.max(0, variance));
    console.log(`${r.padEnd(30)} ${s.n.toString().padStart(5)} ${mean.toFixed(2).padStart(7)} ${sd.toFixed(2).padStart(7)}`);
  }

  console.log(``);
}

void main();
