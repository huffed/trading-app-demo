/**
 * Market-state study — do LEADING market-state features predict trade
 * expectancy, so decay can be detected from the MARKET instead of from
 * the algorithm starting to lose? $0: cached bars + recorded trades,
 * zero LLM calls.
 *
 * Motivation (operator, 2026-06-11): "should it not be analysing the
 * news and market that detects decay, not the algorithm starting to
 * lose?" Correct — outcome feedback is the lagging indicator. This
 * study tests whether cheap PRICE-DERIVED state features, computable
 * with no lookahead at entry time, separate good entry conditions from
 * bad ones on the recorded corpus. Features that separate at meaningful
 * n become SHADOW downshift candidates keyed to market state (leading)
 * rather than P&L drift (lagging).
 *
 * Features (all from cached data, no lookahead):
 *  - vol:    ATR(14) on 4h vs trailing ~1y percentile → low/mid/high
 *  - mtf:    structure alignment across 1h / 4h / D1 (same 3-vs-prior-4
 *            swing compare the harness uses) → aligned_HH / aligned_LH /
 *            ranging_all / fast_div_bull / fast_div_bear / mixed
 *  - range:  20-bar range width vs trailing percentile →
 *            compressed/normal/expanded
 *  - dxy:    EUR/USD 4h 20-bar slope (EUR up = USD down = gold tailwind)
 *            + recent flip → usd_up / usd_down / usd_flip
 *
 * Outcome frame: every recorded entry replayed under comboC:v0 (the
 * incoming config; PR #178 simulator) so R is comparable across cohorts
 * and across the prompt versions that produced the entries.
 *
 * Also prints state attribution for historically-bad stretches (the
 * Feb 2-6 reversal bleed, the W6 losing window, the May-12 live
 * carnage day): did any state flag them in advance?
 *
 * Usage:
 *   pnpm dlx tsx scripts/market-state-study.ts
 *   FILES=...           explicit corpus (default: glob 4h trades JSONLs)
 *   MIN_N=20            min bucket size for the verdict section
 */
import { readdirSync, readFileSync, writeFileSync } from "fs";
import { basename } from "path";
import {
  computeSlForBacktest,
  computeTpForBacktest,
  loadCorpus,
  type Corpus,
} from "./llm-trader-backtest";
import { dailyAtrBefore, simulate, type RecordedTrade, type VariantCfg } from "./exit-mechanics-replay";
import type { PriceBar } from "../src/lib/market-data/types";

// Self-load .env.local (same pattern as sibling scripts)
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

const MIN_N = Number(process.env.MIN_N ?? 20);
const RISK_PCT = Number(process.env.RISK_PCT ?? 0.6);
const CAPITAL = Number(process.env.CAPITAL ?? 100_000);
const COMBO_C = { type: "swing_anchor" as const, value: 0.1, lookback: 4 };
const TP_CFG = { type: "rr_multiple" as const, value: 3 };
const V0: VariantCfg = { key: "v0", honorLlmExits: false, beAtR: null, maxHoldBars: null, partial: null };

type Regime = "HH" | "LH" | "RANGING";

/** Same structural read the harness's daily-bias uses: highest/lowest of
 *  the last 3 bars vs the 4 before them, on any timeframe's bars. */
function swingRegime(bars: PriceBar[], endIdx: number): Regime | null {
  if (endIdx < 7) return null;
  const hi = (a: number, b: number): number => {
    let m = -Infinity;
    for (let i = a; i <= b; i++) m = Math.max(m, bars[i].high);
    return m;
  };
  const lo = (a: number, b: number): number => {
    let m = Infinity;
    for (let i = a; i <= b; i++) m = Math.min(m, bars[i].low);
    return m;
  };
  const last3High = hi(endIdx - 2, endIdx);
  const prev4High = hi(endIdx - 6, endIdx - 3);
  const last3Low = lo(endIdx - 2, endIdx);
  const prev4Low = lo(endIdx - 6, endIdx - 3);
  if (last3High > prev4High && last3Low > prev4Low) return "HH";
  if (last3High < prev4High && last3Low < prev4Low) return "LH";
  return "RANGING";
}

function atr14(bars: PriceBar[], endIdx: number): number | null {
  if (endIdx < 15) return null;
  let s = 0;
  for (let i = endIdx - 13; i <= endIdx; i++) {
    s += Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - bars[i - 1].close),
      Math.abs(bars[i].low - bars[i - 1].close)
    );
  }
  return s / 14;
}

/** Percentile of x within sorted historical values (fraction 0..1). */
function pctile(history: number[], x: number): number | null {
  if (history.length < 100) return null;
  let below = 0;
  for (const h of history) if (h < x) below++;
  return below / history.length;
}

/** Index of the last bar in `bars` with date <= target (binary search). */
function lastIdxAtOrBefore(bars: PriceBar[], target: string): number {
  let lo = 0;
  let hi = bars.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].date <= target) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

interface StateFeatures {
  vol: string;
  mtf: string;
  range: string;
  dxy: string;
}

function discoverFiles(): string[] {
  if (process.env.FILES) return process.env.FILES.split(",").map((s) => s.trim());
  return readdirSync("scripts")
    .filter((f) => /^llm-trader-wf-trades-anthropic-4h-.*\.jsonl$/.test(f))
    .map((f) => `scripts/${f}`);
}

async function main(): Promise<void> {
  const files = discoverFiles();
  if (files.length === 0) throw new Error("No 4h trades JSONLs found (set FILES=...)");

  const corpus: Corpus = await loadCorpus("4h");
  const corpus1h: Corpus = await loadCorpus("1h");
  const bars = corpus.bars;
  const barIdxByDate = new Map<string, number>();
  bars.forEach((b, i) => barIdxByDate.set(b.date, i));

  // Precompute rolling series once (per 4h bar): ATR14 and 20-bar width.
  const atrSeries: (number | null)[] = bars.map((_, i) => atr14(bars, i));
  const widthSeries: (number | null)[] = bars.map((_, i) => {
    if (i < 20) return null;
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = i - 19; j <= i; j++) {
      hi = Math.max(hi, bars[j].high);
      lo = Math.min(lo, bars[j].low);
    }
    return (hi - lo) / bars[i].close;
  });

  function featuresAt(entryIdx: number, entryDate: string): StateFeatures {
    // vol percentile vs trailing ~1y of 4h bars (1560)
    const atrNow = atrSeries[entryIdx];
    const atrHist = atrSeries
      .slice(Math.max(0, entryIdx - 1560), entryIdx)
      .filter((v): v is number => v !== null);
    const volP = atrNow !== null ? pctile(atrHist, atrNow) : null;
    const vol = volP === null ? "n/a" : volP < 0.3 ? "low" : volP > 0.7 ? "high" : "mid";

    // multi-TF structure
    const d1Idx = lastIdxAtOrBefore(corpus.dailyBars, entryDate.slice(0, 10) + " 00:00:00") - 1;
    const h1Idx = lastIdxAtOrBefore(corpus1h.bars, entryDate);
    const d1 = d1Idx >= 7 ? swingRegime(corpus.dailyBars, d1Idx) : null;
    const h4 = swingRegime(bars, entryIdx);
    const h1 = h1Idx >= 7 ? swingRegime(corpus1h.bars, h1Idx) : null;
    let mtf = "n/a";
    if (d1 && h4 && h1) {
      if (d1 === "HH" && h4 === "HH" && h1 === "HH") mtf = "aligned_HH";
      else if (d1 === "LH" && h4 === "LH" && h1 === "LH") mtf = "aligned_LH";
      else if (d1 === "RANGING" && h4 === "RANGING" && h1 === "RANGING") mtf = "ranging_all";
      else if (h1 === "HH" && d1 !== "HH") mtf = "fast_div_bull";
      else if (h1 === "LH" && d1 !== "LH") mtf = "fast_div_bear";
      else mtf = "mixed";
    }

    // range compression
    const wNow = widthSeries[entryIdx];
    const wHist = widthSeries
      .slice(Math.max(0, entryIdx - 500), entryIdx)
      .filter((v): v is number => v !== null);
    const wP = wNow !== null ? pctile(wHist, wNow) : null;
    const range = wP === null ? "n/a" : wP < 0.3 ? "compressed" : wP > 0.7 ? "expanded" : "normal";

    // DXY proxy: EUR/USD 4h 20-bar slope. EUR up = USD down.
    const eIdx = lastIdxAtOrBefore(corpus.eurusd4h, entryDate);
    let dxy = "n/a";
    if (eIdx >= 26) {
      const slope = (i: number): number =>
        corpus.eurusd4h[i].close - corpus.eurusd4h[i - 20].close;
      const now = slope(eIdx);
      let flipped = false;
      for (let k = 1; k <= 6; k++) {
        if (Math.sign(slope(eIdx - k)) !== Math.sign(now)) {
          flipped = true;
          break;
        }
      }
      dxy = flipped ? "usd_flip" : now > 0 ? "usd_down" : "usd_up";
    }
    return { vol, mtf, range, dxy };
  }

  interface StudyTrade {
    cohort: string;
    entryDate: string;
    side: "long" | "short";
    r: number;
    f: StateFeatures;
  }
  const trades: StudyTrade[] = [];
  let unmatched = 0;

  for (const file of files) {
    const cohort = basename(file).match(/-(v[0-9a-z_]+)-\d{4}-/)?.[1] ?? "unknown";
    const lines = readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      const t = JSON.parse(line) as RecordedTrade;
      const entryIdx = barIdxByDate.get(t.entry_date);
      if (entryIdx === undefined || entryIdx >= bars.length - 1) {
        unmatched++;
        continue;
      }
      const slDistance = computeSlForBacktest(bars, entryIdx, t.side, t.entry_price, COMBO_C);
      if (slDistance <= 0) {
        unmatched++;
        continue;
      }
      const regime = (t.entry_regime ?? "n/a") as Regime | "n/a";
      const tpDistance = computeTpForBacktest(slDistance, t.entry_price, TP_CFG, {
        regime: regime as Regime,
        dailyAtr: dailyAtrBefore(corpus.dailyBars, t.entry_date),
      });
      trades.push({
        cohort,
        entryDate: t.entry_date,
        side: t.side,
        r: simulate(t, bars, entryIdx, slDistance, tpDistance, V0).r,
        f: featuresAt(entryIdx, t.entry_date),
      });
    }
  }

  const pad = (s: string, n: number): string => (s.length >= n ? s : s + " ".repeat(n - s.length));
  console.log("\n===== Market-state study (zero LLM calls) =====");
  console.log(
    `corpus: ${trades.length} entries from ${files.length} files (${unmatched} unmatched/skipped) · R frame: comboC:v0 @${RISK_PCT}%\n`
  );

  const agg = (
    ts: StudyTrade[]
  ): { n: number; wr: number; meanR: number; sumR: number } => ({
    n: ts.length,
    wr: ts.length ? (ts.filter((t) => t.r > 0).length / ts.length) * 100 : 0,
    meanR: ts.length ? ts.reduce((s, t) => s + t.r, 0) / ts.length : 0,
    sumR: ts.reduce((s, t) => s + t.r, 0),
  });

  const FEATURES: { label: string; key: (t: StudyTrade) => string }[] = [
    { label: "vol", key: (t) => t.f.vol },
    { label: "mtf_structure", key: (t) => t.f.mtf },
    { label: "range", key: (t) => t.f.range },
    { label: "dxy", key: (t) => t.f.dxy },
  ];

  const overall = agg(trades);
  console.log(
    `overall: n=${overall.n} WR=${overall.wr.toFixed(0)}% meanR=${overall.meanR.toFixed(2)}\n`
  );

  const report: Record<string, unknown> = {};
  const verdicts: string[] = [];
  for (const feat of FEATURES) {
    console.log(`${feat.label}:`);
    console.log(`  ${pad("state", 16)}${pad("n", 6)}${pad("WR", 7)}${pad("meanR", 8)}sumR`);
    const m = new Map<string, StudyTrade[]>();
    for (const t of trades) m.set(feat.key(t), [...(m.get(feat.key(t)) ?? []), t]);
    const featReport: Record<string, unknown> = {};
    for (const [state, ts] of [...m].sort((a, b) => b[1].length - a[1].length)) {
      const a = agg(ts);
      featReport[state] = a;
      console.log(
        `  ${pad(state, 16)}${pad(a.n.toString(), 6)}${pad(`${a.wr.toFixed(0)}%`, 7)}${pad(a.meanR.toFixed(2), 8)}${a.sumR.toFixed(1)}`
      );
      if (a.n >= MIN_N && Math.abs(a.meanR - overall.meanR) >= 0.3) {
        verdicts.push(
          `${feat.label}=${state}: meanR ${a.meanR.toFixed(2)} vs overall ${overall.meanR.toFixed(2)} (n=${a.n}) — ${a.meanR < overall.meanR ? "DOWNSHIFT candidate (shadow first)" : "favourable state"}`
        );
      }
    }
    report[feat.label] = featReport;
    console.log("");
  }

  // Historically-bad stretches: what state were we in?
  const STRETCHES: { label: string; from: string; to: string }[] = [
    { label: "Feb 2-6 reversal bleed", from: "2026-02-02", to: "2026-02-07" },
    { label: "W6 losing window", from: "2026-03-21", to: "2026-04-30" },
    { label: "May 12 live carnage", from: "2026-05-11", to: "2026-05-13" },
  ];
  console.log("--- Bad-stretch state attribution ---");
  for (const s of STRETCHES) {
    const ts = trades.filter((t) => t.entryDate >= s.from && t.entryDate <= s.to);
    if (ts.length === 0) {
      console.log(`  ${s.label}: no recorded entries in range`);
      continue;
    }
    const a = agg(ts);
    const states = new Map<string, number>();
    for (const t of ts)
      states.set(`${t.f.mtf}/${t.f.vol}`, (states.get(`${t.f.mtf}/${t.f.vol}`) ?? 0) + 1);
    const top = [...states].sort((x, y) => y[1] - x[1]).slice(0, 3)
      .map(([k, n]) => `${k}×${n}`)
      .join(", ");
    console.log(
      `  ${s.label}: n=${a.n} meanR=${a.meanR.toFixed(2)} · dominant states: ${top}`
    );
  }

  console.log("\n--- Verdict (|meanR − overall| ≥ 0.3 at n≥" + MIN_N + ") ---");
  if (verdicts.length === 0) {
    console.log("  No feature state separates at meaningful n — the cheap leading-");
    console.log("  indicator version does NOT exist in this corpus; don't wire it.");
  } else {
    for (const v of verdicts) console.log(`  ${v}`);
    console.log("\n  Next step for DOWNSHIFT candidates: shadow-log the state per scan");
    console.log("  tick first; enforcement only after live shadow evidence.");
  }
  console.log("\nCaveats: entries fixed (the LLM already saw regime context, so some");
  console.log("state info is priced into which entries exist); single-instrument;");
  console.log("states are correlated with each other — treat as screening, not proof.");

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outPath = `scripts/market-state-study-${stamp}.json`;
  writeFileSync(
    outPath,
    JSON.stringify(
      { risk_pct: RISK_PCT, capital: CAPITAL, files, unmatched, trades: trades.length,
        overall, features: report, verdicts },
      null,
      2
    )
  );
  console.log(`\nSummary saved: ${outPath}`);
}

main().catch((err) => {
  console.error("market-state-study failed:", err);
  process.exit(1);
});
