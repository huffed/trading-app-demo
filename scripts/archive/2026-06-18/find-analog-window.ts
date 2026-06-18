/**
 * Find historical 30d XAU/USD windows that look most like a reference window.
 *
 * Why: when picking a window for multi-algo dry-runs we want a chart that
 * resembles the present so behaviour translates. "May 2025 looked similar"
 * is a hypothesis — this script tests it numerically.
 *
 * Scoring (lower = closer):
 *   shape_dist     = 1 − Pearson(reference_norm_close, candidate_norm_close)
 *   feat_dist      = z-mean of |Δ(total_return)|, |Δ(daily_vol)|,
 *                    |Δ(max_DD)|, |Δ(trend_slope)|
 *   composite      = 0.5 * shape_dist_z + 0.5 * feat_dist_z
 *
 * Closes are min-max normalized within each window so absolute price level
 * doesn't dominate. Features are z-normalized across all candidate windows.
 *
 * Usage:
 *   pnpm dlx tsx scripts/find-analog-window.ts
 *   END_DATE=2026-05-08 WINDOW_DAYS=30 TOP_N=8 STEP=2 \
 *     pnpm dlx tsx scripts/find-analog-window.ts
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";

interface PriceBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface WindowFeatures {
  startDate: string;
  endDate: string;
  totalReturnPct: number;
  dailyVolPct: number;
  maxDrawdownPct: number;
  trendSlopePctPerBar: number;
  normalizedCloses: number[];
}

interface ScoredCandidate {
  features: WindowFeatures;
  shapeDist: number;
  featDist: number;
  composite: number;
  shapeCorr: number;
}

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

async function loadDailyBars(): Promise<PriceBar[]> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing SUPABASE env vars");
  const supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await supabase
    .from("price_cache")
    .select("bars, bar_count, fetched_at")
    .eq("ticker", "XAU/USD")
    .eq("interval", "1day")
    .order("bar_count", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) throw new Error(`price_cache miss: ${error?.message ?? "no row"}`);
  const bars = (data as { bars: PriceBar[] }).bars;
  return bars.sort((a, b) => a.date.localeCompare(b.date));
}

function computeFeatures(bars: PriceBar[]): WindowFeatures {
  const closes = bars.map((b) => b.close);
  const minC = Math.min(...closes);
  const maxC = Math.max(...closes);
  const range = maxC - minC || 1;
  const normalizedCloses = closes.map((c) => (c - minC) / range);

  const first = closes[0];
  const last = closes[closes.length - 1];
  const totalReturnPct = ((last - first) / first) * 100;

  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    rets.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  }
  const meanRet = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((s, r) => s + (r - meanRet) ** 2, 0) / rets.length;
  const dailyVolPct = Math.sqrt(variance) * 100;

  let peak = closes[0];
  let maxDD = 0;
  for (const c of closes) {
    if (c > peak) peak = c;
    const dd = (c - peak) / peak;
    if (dd < maxDD) maxDD = dd;
  }
  const maxDrawdownPct = maxDD * 100;

  const n = closes.length;
  const xs = closes.map((_, i) => i);
  const xMean = xs.reduce((a, b) => a + b, 0) / n;
  const yMean = closes.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - xMean) * (closes[i] - yMean);
    den += (xs[i] - xMean) ** 2;
  }
  const slope = den === 0 ? 0 : num / den;
  const trendSlopePctPerBar = (slope / yMean) * 100;

  return {
    startDate: bars[0].date.slice(0, 10),
    endDate: bars[bars.length - 1].date.slice(0, 10),
    totalReturnPct,
    dailyVolPct,
    maxDrawdownPct,
    trendSlopePctPerBar,
    normalizedCloses,
  };
}

function pearson(xs: number[], ys: number[]): number {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return 0;
  const xMean = xs.slice(0, n).reduce((a, b) => a + b, 0) / n;
  const yMean = ys.slice(0, n).reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - xMean) * (ys[i] - yMean);
    dx += (xs[i] - xMean) ** 2;
    dy += (ys[i] - yMean) ** 2;
  }
  if (dx === 0 || dy === 0) return 0;
  return num / Math.sqrt(dx * dy);
}

function zScore(values: number[]): number[] {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  const sd = Math.sqrt(variance) || 1;
  return values.map((v) => (v - mean) / sd);
}

async function main(): Promise<void> {
  const endDateStr = process.env.END_DATE ?? new Date().toISOString().slice(0, 10);
  const windowDays = Number(process.env.WINDOW_DAYS ?? "30");
  const step = Number(process.env.STEP ?? "1");
  const topN = Number(process.env.TOP_N ?? "8");
  const minGapDays = Number(process.env.MIN_GAP_DAYS ?? "45");

  console.log(`Analog finder — XAU/USD daily`);
  console.log(`  reference window: ${windowDays}d ending ${endDateStr}`);
  console.log(`  step             : ${step} bar(s)`);
  console.log(`  min gap          : ${minGapDays} days from reference end`);
  console.log(`  top N            : ${topN}`);
  console.log("");

  const bars = await loadDailyBars();
  console.log(`Loaded ${bars.length} daily bars (${bars[0].date.slice(0, 10)} → ${bars[bars.length - 1].date.slice(0, 10)})`);

  const endMs = new Date(`${endDateStr}T23:59:59Z`).getTime();
  let refEndIdx = -1;
  for (let i = bars.length - 1; i >= 0; i--) {
    if (new Date(bars[i].date).getTime() <= endMs) {
      refEndIdx = i;
      break;
    }
  }
  if (refEndIdx === -1) throw new Error(`No bars on/before ${endDateStr}`);
  const refStartIdx = refEndIdx - windowDays + 1;
  if (refStartIdx < 0) throw new Error(`Not enough history before reference end`);

  const refBars = bars.slice(refStartIdx, refEndIdx + 1);
  const refFeatures = computeFeatures(refBars);
  console.log(`\nReference window: ${refFeatures.startDate} → ${refFeatures.endDate}`);
  console.log(`  total return    : ${refFeatures.totalReturnPct.toFixed(2)}%`);
  console.log(`  daily vol       : ${refFeatures.dailyVolPct.toFixed(2)}%`);
  console.log(`  max DD          : ${refFeatures.maxDrawdownPct.toFixed(2)}%`);
  console.log(`  trend slope     : ${refFeatures.trendSlopePctPerBar.toFixed(3)}%/bar`);
  console.log("");

  const candidates: WindowFeatures[] = [];
  const refStartMs = new Date(refFeatures.startDate).getTime();
  const minGapMs = minGapDays * 24 * 3600 * 1000;
  const earliestStartStr = process.env.EARLIEST_START;
  const earliestStartMs = earliestStartStr
    ? new Date(`${earliestStartStr}T00:00:00Z`).getTime()
    : -Infinity;
  for (let endIdx = windowDays - 1; endIdx < refStartIdx; endIdx += step) {
    const startIdx = endIdx - windowDays + 1;
    const winBars = bars.slice(startIdx, endIdx + 1);
    const winEndMs = new Date(winBars[winBars.length - 1].date).getTime();
    const winStartMs = new Date(winBars[0].date).getTime();
    if (refStartMs - winEndMs < minGapMs) continue;
    if (winStartMs < earliestStartMs) continue;
    candidates.push(computeFeatures(winBars));
  }
  console.log(`Scanned ${candidates.length} candidate windows`);

  const shapeDists = candidates.map((c) => 1 - pearson(refFeatures.normalizedCloses, c.normalizedCloses));
  const featRaw = candidates.map((c) =>
    Math.abs(c.totalReturnPct - refFeatures.totalReturnPct) +
    Math.abs(c.dailyVolPct - refFeatures.dailyVolPct) +
    Math.abs(c.maxDrawdownPct - refFeatures.maxDrawdownPct) +
    Math.abs(c.trendSlopePctPerBar - refFeatures.trendSlopePctPerBar) * 10
  );
  const shapeZ = zScore(shapeDists);
  const featZ = zScore(featRaw);

  const scored: ScoredCandidate[] = candidates.map((c, i) => ({
    features: c,
    shapeDist: shapeDists[i],
    featDist: featRaw[i],
    shapeCorr: 1 - shapeDists[i],
    composite: 0.5 * shapeZ[i] + 0.5 * featZ[i],
  }));

  scored.sort((a, b) => a.composite - b.composite);

  const overlap = (a: WindowFeatures, b: WindowFeatures) => {
    const aS = new Date(a.startDate).getTime();
    const aE = new Date(a.endDate).getTime();
    const bS = new Date(b.startDate).getTime();
    const bE = new Date(b.endDate).getTime();
    return aS <= bE && bS <= aE;
  };
  const top: ScoredCandidate[] = [];
  for (const cand of scored) {
    if (top.some((t) => overlap(cand.features, t.features))) continue;
    top.push(cand);
    if (top.length >= topN) break;
  }

  console.log(`\nTop ${top.length} analog windows (composite ascending — lower is closer):\n`);
  console.log(
    "rank | window                 | shapeCorr | retΔ%    | volΔ%   | ddΔ%    | slopeΔ   | composite"
  );
  console.log("-----+------------------------+-----------+----------+---------+---------+----------+----------");
  for (let i = 0; i < top.length; i++) {
    const t = top[i];
    const w = t.features;
    const retΔ = w.totalReturnPct - refFeatures.totalReturnPct;
    const volΔ = w.dailyVolPct - refFeatures.dailyVolPct;
    const ddΔ = w.maxDrawdownPct - refFeatures.maxDrawdownPct;
    const slopeΔ = w.trendSlopePctPerBar - refFeatures.trendSlopePctPerBar;
    console.log(
      ` ${(i + 1).toString().padStart(2, " ")}  | ${w.startDate} → ${w.endDate} | ` +
        `${t.shapeCorr.toFixed(3).padStart(9, " ")} | ` +
        `${retΔ >= 0 ? "+" : ""}${retΔ.toFixed(2).padStart(6, " ")} | ` +
        `${volΔ >= 0 ? "+" : ""}${volΔ.toFixed(2).padStart(5, " ")} | ` +
        `${ddΔ >= 0 ? "+" : ""}${ddΔ.toFixed(2).padStart(5, " ")} | ` +
        `${slopeΔ >= 0 ? "+" : ""}${slopeΔ.toFixed(3).padStart(6, " ")} | ` +
        `${t.composite.toFixed(3).padStart(7, " ")}`
    );
  }

  const may2025 = scored
    .filter((c) => c.features.endDate.startsWith("2025-05") || c.features.endDate.startsWith("2025-04"))
    .sort((a, b) => a.composite - b.composite)[0];
  if (may2025) {
    console.log(
      `\nMay 2025 hypothesis — best window in 2025-04..2025-05: ${may2025.features.startDate} → ${may2025.features.endDate}`
    );
    console.log(
      `  shapeCorr=${may2025.shapeCorr.toFixed(3)}  composite=${may2025.composite.toFixed(3)}  rank=${scored.findIndex((s) => s === may2025) + 1}/${scored.length}`
    );
  }

  console.log("\nReference details (for visual comparison):");
  console.log(`  closes start = ${refBars[0].close.toFixed(2)} | end = ${refBars[refBars.length - 1].close.toFixed(2)}`);
  console.log(`  hi = ${Math.max(...refBars.map((b) => b.high)).toFixed(2)} | lo = ${Math.min(...refBars.map((b) => b.low)).toFixed(2)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
