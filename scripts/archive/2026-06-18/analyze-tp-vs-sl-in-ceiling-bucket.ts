/**
 * Within the 80-100% (near-ceiling) bucket: what distinguishes
 * TP-hits from SL-hits?
 *
 * Tests several patterns:
 *   1. Sub-position (80-90% vs 90-100%) — proximity to ceiling
 *   2. Prior-bar momentum (uptrend vs downtrend going into entry)
 *   3. Day of week
 *   4. UTC hour of entry
 *   5. Bar size at entry (compressed vs expanded)
 *   6. Side (long vs short)
 *   7. Per-algo TP/SL ratio
 *
 * Goal: find a clean filter that drops most SL-hits without losing many
 * TP-hits.
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

interface Trade {
  algo_name: string;
  ticker: string;
  side: "long" | "short";
  entry_date: string;
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

function findBarIdx(bars: PriceBar[], date: string): number {
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

interface Features {
  sub_pos: "80-90" | "90-95" | "95-100";
  prior_3bar_net_pct: number;       // (close - close_3_bars_ago) / close_3_bars_ago × 100, side-adjusted
  dow: number;                       // 0=Sunday..6=Saturday
  hour: number;                      // 0-23 UTC
  bar_size_pct: number;             // bar's range / close × 100
  side: "long" | "short";
  algo: string;
  outcome: "tp" | "sl" | "other";
}

function featurize(bars: PriceBar[], idx: number, ext: { high: number; low: number }, t: Trade): Features | null {
  if (idx < 3) return null;
  const bar = bars[idx];
  // sub-position
  const range = ext.high - ext.low;
  if (range <= 0) return null;
  const posLong = (t.entry_price - ext.low) / range;
  const pos = t.side === "long" ? posLong : 1 - posLong;
  if (pos < 0.8) return null;
  const sub: Features["sub_pos"] = pos < 0.9 ? "80-90" : pos < 0.95 ? "90-95" : "95-100";
  // prior 3-bar net change (side-adjusted: positive = trades-with-trend)
  const close0 = bar.close;
  const close3 = bars[idx - 3].close;
  let priorNet = (close0 - close3) / close3 * 100;
  if (t.side === "short") priorNet = -priorNet;
  // day of week + hour
  const d = new Date(t.entry_date);
  const dow = d.getUTCDay();
  const hour = d.getUTCHours();
  // bar size
  const barSize = (bar.high - bar.low) / bar.close * 100;
  // outcome
  const r = t.exit_reason ?? "";
  const outcome: Features["outcome"] = r.includes("take_profit") ? "tp" : r.includes("stop_loss") ? "sl" : "other";
  return {
    sub_pos: sub,
    prior_3bar_net_pct: priorNet,
    dow,
    hour,
    bar_size_pct: barSize,
    side: t.side,
    algo: t.algo_name,
    outcome,
  };
}

async function main(): Promise<void> {
  console.log(`\n===== Within 80-100% bucket: what distinguishes TP-hits from SL-hits? @ ${new Date().toISOString().slice(0, 16)} =====\n`);
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
  const trades: Trade[] = ((tradesRes.data ?? []) as any[]).map((t) => {
    const meta = algoMap.get(t.algorithm_id);
    return {
      algo_name: meta?.name ?? "?",
      ticker: (t.ticker ?? "").toUpperCase(),
      side: t.side,
      entry_date: t.entry_date,
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

  // Featurize trades in 80-100% bucket
  const feats: Features[] = [];
  for (const t of trades) {
    const tfMap = barCaches.get(t.ticker);
    if (!tfMap) continue;
    const interval = timeframeToInterval(t.timeframe);
    const bars = tfMap.get(interval) ?? tfMap.get("4h");
    if (!bars) continue;
    const ext = rollingExtreme(bars, t.entry_date, ROLLING_MONTHS);
    if (!ext) continue;
    const idx = findBarIdx(bars, t.entry_date);
    if (idx < 0) continue;
    const f = featurize(bars, idx, ext, t);
    if (f) feats.push(f);
  }

  console.log(`Featurized ${feats.length} trades in 80-100% bucket.\n`);
  const tp = feats.filter((f) => f.outcome === "tp");
  const sl = feats.filter((f) => f.outcome === "sl");
  console.log(`TP hits: ${tp.length} (${(tp.length / feats.length * 100).toFixed(1)}%)`);
  console.log(`SL hits: ${sl.length} (${(sl.length / feats.length * 100).toFixed(1)}%)`);
  console.log(`other:   ${feats.length - tp.length - sl.length}\n`);

  // ----- 1. Sub-position -----
  console.log(`${"=".repeat(80)}\n1. SUB-POSITION (80-90% vs 90-95% vs 95-100%)\n${"=".repeat(80)}`);
  for (const sp of ["80-90", "90-95", "95-100"] as const) {
    const n = feats.filter((f) => f.sub_pos === sp).length;
    const tpN = feats.filter((f) => f.sub_pos === sp && f.outcome === "tp").length;
    const slN = feats.filter((f) => f.sub_pos === sp && f.outcome === "sl").length;
    const tpPct = n > 0 ? (tpN / n * 100).toFixed(1) : "—";
    const slPct = n > 0 ? (slN / n * 100).toFixed(1) : "—";
    console.log(`  ${sp.padEnd(8)} n=${n.toString().padStart(3)}  TP ${tpPct.padStart(5)}%  SL ${slPct.padStart(5)}%`);
  }

  // ----- 2. Prior 3-bar net change (momentum into entry) -----
  console.log(`\n${"=".repeat(80)}\n2. PRIOR 3-BAR NET CHANGE (% trend into entry, side-adjusted)\n${"=".repeat(80)}`);
  const momentumBuckets = [
    { label: "strong against (<-2%)", min: -Infinity, max: -2 },
    { label: "weak against (-2 to -0.5%)", min: -2, max: -0.5 },
    { label: "flat (-0.5 to +0.5%)", min: -0.5, max: 0.5 },
    { label: "weak with (+0.5 to +2%)", min: 0.5, max: 2 },
    { label: "strong with (>+2%)", min: 2, max: Infinity },
  ];
  for (const b of momentumBuckets) {
    const inB = feats.filter((f) => f.prior_3bar_net_pct >= b.min && f.prior_3bar_net_pct < b.max);
    const tpN = inB.filter((f) => f.outcome === "tp").length;
    const slN = inB.filter((f) => f.outcome === "sl").length;
    const tpPct = inB.length > 0 ? (tpN / inB.length * 100).toFixed(1) : "—";
    const slPct = inB.length > 0 ? (slN / inB.length * 100).toFixed(1) : "—";
    console.log(`  ${b.label.padEnd(28)} n=${inB.length.toString().padStart(3)}  TP ${tpPct.padStart(5)}%  SL ${slPct.padStart(5)}%`);
  }

  // ----- 3. Day of week -----
  console.log(`\n${"=".repeat(80)}\n3. DAY OF WEEK (UTC)\n${"=".repeat(80)}`);
  const dowNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  for (let d = 0; d < 7; d++) {
    const inD = feats.filter((f) => f.dow === d);
    const tpN = inD.filter((f) => f.outcome === "tp").length;
    const slN = inD.filter((f) => f.outcome === "sl").length;
    const tpPct = inD.length > 0 ? (tpN / inD.length * 100).toFixed(1) : "—";
    const slPct = inD.length > 0 ? (slN / inD.length * 100).toFixed(1) : "—";
    console.log(`  ${dowNames[d].padEnd(4)} n=${inD.length.toString().padStart(3)}  TP ${tpPct.padStart(5)}%  SL ${slPct.padStart(5)}%`);
  }

  // ----- 4. UTC Hour of entry -----
  console.log(`\n${"=".repeat(80)}\n4. UTC HOUR (sessions)\n${"=".repeat(80)}`);
  const hourBuckets = [
    { label: "Asia open (00-07)", min: 0, max: 8 },
    { label: "London open (08-12)", min: 8, max: 13 },
    { label: "NY open (13-17)", min: 13, max: 18 },
    { label: "Asia evening (18-23)", min: 18, max: 24 },
  ];
  for (const b of hourBuckets) {
    const inB = feats.filter((f) => f.hour >= b.min && f.hour < b.max);
    const tpN = inB.filter((f) => f.outcome === "tp").length;
    const slN = inB.filter((f) => f.outcome === "sl").length;
    const tpPct = inB.length > 0 ? (tpN / inB.length * 100).toFixed(1) : "—";
    const slPct = inB.length > 0 ? (slN / inB.length * 100).toFixed(1) : "—";
    console.log(`  ${b.label.padEnd(28)} n=${inB.length.toString().padStart(3)}  TP ${tpPct.padStart(5)}%  SL ${slPct.padStart(5)}%`);
  }

  // ----- 5. Side (long vs short) -----
  console.log(`\n${"=".repeat(80)}\n5. SIDE (long vs short, near respective extremes)\n${"=".repeat(80)}`);
  for (const s of ["long", "short"] as const) {
    const inS = feats.filter((f) => f.side === s);
    const tpN = inS.filter((f) => f.outcome === "tp").length;
    const slN = inS.filter((f) => f.outcome === "sl").length;
    const tpPct = inS.length > 0 ? (tpN / inS.length * 100).toFixed(1) : "—";
    const slPct = inS.length > 0 ? (slN / inS.length * 100).toFixed(1) : "—";
    console.log(`  ${s.padEnd(8)} n=${inS.length.toString().padStart(3)}  TP ${tpPct.padStart(5)}%  SL ${slPct.padStart(5)}%`);
  }

  // ----- 6. Bar size at entry -----
  console.log(`\n${"=".repeat(80)}\n6. ENTRY BAR SIZE (range/close × 100)\n${"=".repeat(80)}`);
  // Median bar size as cutoff
  const sizes = feats.map((f) => f.bar_size_pct).sort((a, b) => a - b);
  const median = sizes[Math.floor(sizes.length / 2)];
  console.log(`  (Median bar size: ${median.toFixed(2)}%)\n`);
  const small = feats.filter((f) => f.bar_size_pct < median);
  const large = feats.filter((f) => f.bar_size_pct >= median);
  for (const [label, arr] of [["small (< median)", small], ["large (>= median)", large]] as const) {
    const tpN = arr.filter((f) => f.outcome === "tp").length;
    const slN = arr.filter((f) => f.outcome === "sl").length;
    const tpPct = arr.length > 0 ? (tpN / arr.length * 100).toFixed(1) : "—";
    const slPct = arr.length > 0 ? (slN / arr.length * 100).toFixed(1) : "—";
    console.log(`  ${label.padEnd(20)} n=${arr.length.toString().padStart(3)}  TP ${tpPct.padStart(5)}%  SL ${slPct.padStart(5)}%`);
  }

  // ----- 7. Look for the best signal: any feature where TP rate >> SL rate? -----
  console.log(`\n${"=".repeat(80)}\n7. WINNER FEATURES (sorted by TP-rate lift vs baseline)\n${"=".repeat(80)}`);
  const baselineTp = tp.length / feats.length * 100;
  console.log(`  Baseline TP rate in 80-100% bucket: ${baselineTp.toFixed(1)}%\n`);
  interface FeatLift {
    name: string;
    n: number;
    tpRate: number;
    lift: number;
  }
  const lifts: FeatLift[] = [];
  // Sub-position
  for (const sp of ["80-90", "90-95", "95-100"] as const) {
    const inB = feats.filter((f) => f.sub_pos === sp);
    if (inB.length < 10) continue;
    const tpN = inB.filter((f) => f.outcome === "tp").length;
    lifts.push({ name: `sub=${sp}`, n: inB.length, tpRate: tpN / inB.length * 100, lift: tpN / inB.length * 100 - baselineTp });
  }
  // Momentum
  for (const b of momentumBuckets) {
    const inB = feats.filter((f) => f.prior_3bar_net_pct >= b.min && f.prior_3bar_net_pct < b.max);
    if (inB.length < 10) continue;
    const tpN = inB.filter((f) => f.outcome === "tp").length;
    lifts.push({ name: `momentum=${b.label}`, n: inB.length, tpRate: tpN / inB.length * 100, lift: tpN / inB.length * 100 - baselineTp });
  }
  // DOW
  for (let d = 0; d < 7; d++) {
    const inB = feats.filter((f) => f.dow === d);
    if (inB.length < 10) continue;
    const tpN = inB.filter((f) => f.outcome === "tp").length;
    lifts.push({ name: `dow=${dowNames[d]}`, n: inB.length, tpRate: tpN / inB.length * 100, lift: tpN / inB.length * 100 - baselineTp });
  }
  // Session
  for (const b of hourBuckets) {
    const inB = feats.filter((f) => f.hour >= b.min && f.hour < b.max);
    if (inB.length < 10) continue;
    const tpN = inB.filter((f) => f.outcome === "tp").length;
    lifts.push({ name: `session=${b.label}`, n: inB.length, tpRate: tpN / inB.length * 100, lift: tpN / inB.length * 100 - baselineTp });
  }
  // Side
  for (const s of ["long", "short"] as const) {
    const inB = feats.filter((f) => f.side === s);
    if (inB.length < 10) continue;
    const tpN = inB.filter((f) => f.outcome === "tp").length;
    lifts.push({ name: `side=${s}`, n: inB.length, tpRate: tpN / inB.length * 100, lift: tpN / inB.length * 100 - baselineTp });
  }
  // Bar size
  lifts.push({ name: "bar_size=small", n: small.length, tpRate: small.filter((f) => f.outcome === "tp").length / small.length * 100, lift: small.filter((f) => f.outcome === "tp").length / small.length * 100 - baselineTp });
  lifts.push({ name: "bar_size=large", n: large.length, tpRate: large.filter((f) => f.outcome === "tp").length / large.length * 100, lift: large.filter((f) => f.outcome === "tp").length / large.length * 100 - baselineTp });

  lifts.sort((a, b) => b.lift - a.lift);
  console.log(`${"FEATURE".padEnd(35)} ${"n".padStart(5)} ${"TP %".padStart(7)} ${"lift vs baseline".padStart(18)}`);
  for (const l of lifts) {
    const sign = l.lift >= 0 ? "+" : "";
    console.log(`${l.name.padEnd(35)} ${l.n.toString().padStart(5)} ${l.tpRate.toFixed(1).padStart(6)}% ${(sign + l.lift.toFixed(1) + "pp").padStart(18)}`);
  }
  console.log(``);

  console.log(`Interpretation:`);
  console.log(`  - Features with lift > +5pp = consider as ALLOW filter (let through more good ones)`);
  console.log(`  - Features with lift < -5pp = consider as REFUSE filter (block bad ones)`);
  console.log(`  - Features near baseline = not informative`);
}

void main();
