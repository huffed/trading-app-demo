/**
 * Hold-side opportunity screen — $0, zero LLM calls.
 *
 * The market-state study (PR #188) bucketed the trades the LLM TOOK.
 * That conditions every per-state R figure on the LLM's chart-read —
 * the unexamined 94% of bars are the holds. This screen mines them:
 *
 *  - Collect every FLAT "hold" decision from recorded 4h walk-forward
 *    decision logs (llm-trader-wf-decisions-*-4h-*.jsonl), deduped by
 *    bar date across reps/cohorts.
 *  - For each bar, compute the market state (same module live uses) and
 *    simulate BOTH hypothetical entries (long + short) at bar close
 *    under comboC geometry + v0 mechanics (no LLM exits, no BE).
 *  - Report foregone R per state bucket and per side.
 *
 * How to read it: a state bucket where hold-bars show strong forward R
 * means a mechanical state+trigger entry can capture edge the LLM
 * leaves on the table (library candidate evidence). A bucket where
 * taken-trades earn but hold-bars don't means the LLM's chart-read IS
 * the edge there — a state-only mechanical entry would underperform.
 *
 * Usage:
 *   pnpm dlx tsx scripts/hold-side-screen.ts
 *   FILES=a.jsonl,b.jsonl   explicit decision logs (default: glob
 *                           scripts/llm-trader-wf-decisions-*-4h-*.jsonl)
 *   RISK_PCT=0.6 CAPITAL=100000   $ scaling for the report only
 */
import { readdirSync, readFileSync, writeFileSync } from "fs";
import {
  computeMarketState4h,
  type MarketState,
} from "../src/lib/market-data/market-state";
import type { PriceBar } from "../src/lib/market-data/types";
import { dailyAtrBefore, simulate, type RecordedTrade, type VariantCfg } from "./exit-mechanics-replay";
import {
  computeSlForBacktest,
  computeTpForBacktest,
  loadCorpus,
  type Corpus,
  type Regime,
} from "./llm-trader-backtest";

const RISK_PCT = Number(process.env.RISK_PCT ?? 0.6);
const CAPITAL = Number(process.env.CAPITAL ?? 100_000);
const RISK_USD = CAPITAL * (RISK_PCT / 100);

const COMBO_C = { type: "swing_anchor" as const, value: 0.1, lookback: 4 };
const TP_CFG = { type: "rr_multiple" as const, value: 3 };
const V0: VariantCfg = {
  key: "v0",
  honorLlmExits: false,
  beAtR: null,
  maxHoldBars: null,
  partial: null,
};

interface DecisionRow {
  bar_date: string;
  regime?: string;
  decision: string;
  had_position: string;
}

function discoverFiles(): string[] {
  if (process.env.FILES) return process.env.FILES.split(",").map((s) => s.trim());
  return readdirSync("scripts")
    .filter((f) => /^llm-trader-wf-decisions-.*-4h-.*\.jsonl$/.test(f))
    .map((f) => `scripts/${f}`);
}

interface HoldBar {
  barDate: string;
  regime: Regime;
  seenIn: number;
}

async function main(): Promise<void> {
  const files = discoverFiles();
  if (files.length === 0) throw new Error("No 4h decision JSONLs found (set FILES=...)");

  // Dedupe flat holds across reps/cohorts — the question is market-level
  // ("what was available on this bar"), not per-run.
  const holdBars = new Map<string, HoldBar>();
  let totalRows = 0;
  let flatHoldRows = 0;
  for (const file of files) {
    for (const line of readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean)) {
      const d = JSON.parse(line) as DecisionRow;
      totalRows++;
      if (d.had_position !== "flat" || d.decision !== "hold") continue;
      flatHoldRows++;
      const existing = holdBars.get(d.bar_date);
      if (existing) existing.seenIn++;
      else
        holdBars.set(d.bar_date, {
          barDate: d.bar_date,
          regime: (d.regime ?? "n/a") as Regime,
          seenIn: 1,
        });
    }
  }

  const corpus: Corpus = await loadCorpus("4h");
  const corpus1h: Corpus = await loadCorpus("1h");
  const bars = corpus.bars;
  const barIdxByDate = new Map<string, number>();
  bars.forEach((b, i) => barIdxByDate.set(b.date, i));

  interface HoldOutcome {
    barDate: string;
    state: MarketState;
    longR: number;
    shortR: number;
  }
  const outcomes: HoldOutcome[] = [];
  let unmatched = 0;

  for (const hb of holdBars.values()) {
    const idx = barIdxByDate.get(hb.barDate);
    // Need forward bars to simulate an exit path.
    if (idx === undefined || idx >= bars.length - 2) {
      unmatched++;
      continue;
    }
    const entryPrice = bars[idx].close;
    const dailyAtr = dailyAtrBefore(corpus.dailyBars, hb.barDate);
    const state = computeMarketState4h(
      {
        bars4h: bars,
        oneHourBars: corpus1h.bars,
        dailyBars: corpus.dailyBars,
        eurusd4h: corpus.eurusd4h,
      },
      idx
    );
    const sideR = (side: "long" | "short"): number | null => {
      const slDistance = computeSlForBacktest(bars, idx, side, entryPrice, COMBO_C);
      if (slDistance <= 0) return null;
      const tpDistance = computeTpForBacktest(slDistance, entryPrice, TP_CFG, {
        regime: hb.regime,
        dailyAtr,
      });
      const trade: RecordedTrade = {
        side,
        entry_price: entryPrice,
        exit_price: entryPrice,
        entry_date: hb.barDate,
        exit_date: hb.barDate,
        exit_reason: "hypothetical",
      };
      return simulate(trade, bars, idx, slDistance, tpDistance, V0).r;
    };
    const longR = sideR("long");
    const shortR = sideR("short");
    if (longR === null || shortR === null) {
      unmatched++;
      continue;
    }
    outcomes.push({ barDate: hb.barDate, state, longR, shortR });
  }

  const pad = (s: string, n: number): string => (s.length >= n ? s : s + " ".repeat(n - s.length));
  const agg = (rs: number[]): { n: number; wr: number; meanR: number; sumR: number } => ({
    n: rs.length,
    wr: rs.length ? (rs.filter((r) => r > 0).length / rs.length) * 100 : 0,
    meanR: rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : 0,
    sumR: rs.reduce((a, b) => a + b, 0),
  });

  console.log("\n===== Hold-side opportunity screen (zero LLM calls) =====");
  console.log(
    `decision rows: ${totalRows} · flat holds: ${flatHoldRows} · distinct hold bars: ${holdBars.size} · simulated: ${outcomes.length} (${unmatched} unmatched/short-history)`
  );
  console.log(
    `geometry: comboC swing_anchor 0.10/4 + rr3 adaptive · mechanics v0 · R frame @${RISK_PCT}% of $${CAPITAL.toLocaleString()} = $${RISK_USD.toFixed(0)}/R\n`
  );

  const oAllL = agg(outcomes.map((o) => o.longR));
  const oAllS = agg(outcomes.map((o) => o.shortR));
  console.log(
    `ALL hold bars   LONG  n=${oAllL.n} WR=${oAllL.wr.toFixed(0)}% meanR=${oAllL.meanR.toFixed(2)} sumR=${oAllL.sumR.toFixed(1)}`
  );
  console.log(
    `                SHORT n=${oAllS.n} WR=${oAllS.wr.toFixed(0)}% meanR=${oAllS.meanR.toFixed(2)} sumR=${oAllS.sumR.toFixed(1)}\n`
  );

  const FEATURES: { label: string; key: (s: MarketState) => string }[] = [
    { label: "vol", key: (s) => s.vol },
    { label: "mtf_structure", key: (s) => s.mtf },
    { label: "range", key: (s) => s.range },
    { label: "dxy", key: (s) => s.dxy },
  ];
  const report: Record<string, unknown> = {};
  for (const feat of FEATURES) {
    console.log(`${feat.label} (hold bars — hypothetical comboC entries):`);
    console.log(
      `  ${pad("state", 16)}${pad("n", 6)}${pad("longWR", 8)}${pad("longR", 8)}${pad("shortWR", 9)}shortR`
    );
    const m = new Map<string, HoldOutcome[]>();
    for (const o of outcomes) m.set(feat.key(o.state), [...(m.get(feat.key(o.state)) ?? []), o]);
    const featReport: Record<string, unknown> = {};
    for (const [state, os] of [...m].sort((a, b) => b[1].length - a[1].length)) {
      const l = agg(os.map((o) => o.longR));
      const s = agg(os.map((o) => o.shortR));
      featReport[state] = { n: os.length, long: l, short: s };
      console.log(
        `  ${pad(state, 16)}${pad(String(os.length), 6)}${pad(`${l.wr.toFixed(0)}%`, 8)}${pad(l.meanR.toFixed(2), 8)}${pad(`${s.wr.toFixed(0)}%`, 9)}${s.meanR.toFixed(2)}`
      );
    }
    report[feat.label] = featReport;
    console.log("");
  }

  console.log("Caveats:");
  console.log("  - Hypothetical entries at bar close — no spread/slippage, no gates.");
  console.log("  - Every flat-hold bar simulated; overlapping hypothetical positions");
  console.log("    are NOT netted (a trending week counts each bar's entry separately),");
  console.log("    so sumR overstates a 1-position strategy. Read meanR, not sumR.");
  console.log("  - Compare against the study's TAKEN-trade table: holds beating takes");
  console.log("    in a state = LLM too conservative there (mechanical candidate);");
  console.log("    takes beating holds = the chart-read is the edge (keep the LLM).");

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outPath = `scripts/hold-side-screen-${stamp}.json`;
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        risk_pct: RISK_PCT,
        capital: CAPITAL,
        files,
        decision_rows: totalRows,
        flat_hold_rows: flatHoldRows,
        distinct_hold_bars: holdBars.size,
        simulated: outcomes.length,
        unmatched,
        overall: { long: oAllL, short: oAllS },
        features: report,
      },
      null,
      2
    )
  );
  console.log(`\nSummary saved: ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
