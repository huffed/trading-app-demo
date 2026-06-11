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
import {
  computeMarketState4h,
  type MarketState,
} from "../src/lib/market-data/market-state";

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

  interface StudyTrade {
    cohort: string;
    entryDate: string;
    side: "long" | "short";
    r: number;
    f: MarketState;
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
        f: computeMarketState4h(
          {
            bars4h: bars,
            oneHourBars: corpus1h.bars,
            dailyBars: corpus.dailyBars,
            eurusd4h: corpus.eurusd4h,
          },
          entryIdx
        ),
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

  // Direction split (SIDE_SPLIT=1) — feedback_direction_split_first:
  // mixed long+short medians can flip when split; never conclude on
  // combined tables alone.
  if (process.env.SIDE_SPLIT === "1") {
    for (const side of ["long", "short"] as const) {
      const sub = trades.filter((t) => t.side === side);
      const o = agg(sub);
      console.log(
        `===== ${side.toUpperCase()} only: n=${o.n} WR=${o.wr.toFixed(0)}% meanR=${o.meanR.toFixed(2)} =====`
      );
      for (const feat of FEATURES) {
        const m = new Map<string, StudyTrade[]>();
        for (const t of sub) m.set(feat.key(t), [...(m.get(feat.key(t)) ?? []), t]);
        const line = [...m]
          .sort((a, b) => b[1].length - a[1].length)
          .map(([state, ts]) => {
            const a = agg(ts);
            return `${state} n=${a.n} ${a.meanR.toFixed(2)}R`;
          })
          .join(" · ");
        console.log(`  ${pad(feat.label, 14)}${line}`);
      }
      console.log("");
    }
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
