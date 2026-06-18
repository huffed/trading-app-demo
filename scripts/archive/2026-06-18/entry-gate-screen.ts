/**
 * Entry-gate screen — $0 screening of engine-level ENTRY gates over the
 * recorded walk-forward corpus. Zero LLM calls.
 *
 * Premise: an entry gate is a FILTER on recorded entries — unlike exit
 * mechanics it can only remove trades, never alter them. So its value is
 * measured by what it BLOCKS: gated total R = ungated − blocked, and a
 * gate earns its place only when the blocked cohort's expectancy is
 * sharply negative (it specifically avoids losers, not just trades).
 *
 * Gates screened (Phase-1 / rebuild-plan B2, friend's framework):
 *  - Premium/discount (pdNN): longs only in the lower NN% of the 20-bar
 *    range at entry; shorts only in the upper NN% (symmetric). Implements
 *    "long in discount, sell in premium".
 *  - Anti-chase (chaseT): block longs when the last-3-bar move exceeds
 *    +T%; shorts when below −T%. Targets the 2026-05 entry-quality leak
 *    (entries adverse within 1h after extended moves).
 *  - combo: pd60 + chase06 together.
 *
 * Gate inputs are computed FROM BARS at the entry index (no lookahead):
 * range position over the 20 bars ending at entry; momentum over the
 * prior 3 bars. Kept-set outcomes are simulated with the PR #178
 * mechanics (v0 = pure SL/TP, conservative same-bar SL-first) under both
 * the comboC and live geometries.
 *
 * Session splits are printed as INFO ONLY — session gating has a bad
 * calibration history here (the dead-hour gate was calibrated on
 * mislabeled-timezone bars); per-session cohorts go through the weekly
 * cohort report + shadow-gate path instead.
 *
 * Caveats (same family as PR #178): entries held fixed; a gate cannot
 * create the better entries the LLM might have taken later; consec-halt
 * knock-ons ignored. Winners here still need the ONE paid WF
 * confirmation before any live wiring.
 *
 * Usage:
 *   pnpm dlx tsx scripts/entry-gate-screen.ts
 *   FILES=a.jsonl,b.jsonl   explicit corpus (default: glob
 *                           scripts/llm-trader-wf-trades-*.jsonl)
 *   RISK_PCT=0.75 CAPITAL=100000
 */
import { readdirSync, readFileSync, writeFileSync } from "fs";
import { basename } from "path";
import {
  computeSlForBacktest,
  computeTpForBacktest,
  loadCorpus,
  type Corpus,
} from "./llm-trader-backtest";
import {
  dailyAtrBefore,
  simulate,
  GEOMETRIES,
  type Geometry,
  type RecordedTrade,
  type VariantCfg,
} from "./exit-mechanics-replay";
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

const RISK_PCT = Number(process.env.RISK_PCT ?? 0.75);
const CAPITAL = Number(process.env.CAPITAL ?? 100_000);
const RISK_USD = CAPITAL * (RISK_PCT / 100);
const TP_CFG = { type: "rr_multiple" as const, value: 3 };
const V0: VariantCfg = { key: "v0", honorLlmExits: false, beAtR: null, maxHoldBars: null, partial: null };

interface GateInputs {
  rangePos: number | null; // 0..1 position in the 20-bar range at entry
  mom3Pct: number | null; // close-to-close move over prior 3 bars, %
}

function gateInputsAt(bars: PriceBar[], entryIdx: number, entryPrice: number): GateInputs {
  const start = Math.max(0, entryIdx - 19);
  let hi = -Infinity;
  let lo = Infinity;
  for (let i = start; i <= entryIdx; i++) {
    hi = Math.max(hi, bars[i].high);
    lo = Math.min(lo, bars[i].low);
  }
  const rangePos = hi > lo ? (entryPrice - lo) / (hi - lo) : null;
  const mom3Pct =
    entryIdx >= 3 && bars[entryIdx - 3].close > 0
      ? ((bars[entryIdx].close - bars[entryIdx - 3].close) / bars[entryIdx - 3].close) * 100
      : null;
  return { rangePos, mom3Pct };
}

interface GateDef {
  key: string;
  blocks: (side: "long" | "short", g: GateInputs) => boolean;
}

function pdGate(maxLongPos: number): (side: "long" | "short", g: GateInputs) => boolean {
  return (side, g) => {
    if (g.rangePos === null) return false;
    return side === "long" ? g.rangePos > maxLongPos : g.rangePos < 1 - maxLongPos;
  };
}

function chaseGate(thresholdPct: number): (side: "long" | "short", g: GateInputs) => boolean {
  return (side, g) => {
    if (g.mom3Pct === null) return false;
    return side === "long" ? g.mom3Pct > thresholdPct : g.mom3Pct < -thresholdPct;
  };
}

const GATES: GateDef[] = [
  { key: "pd50", blocks: pdGate(0.5) },
  { key: "pd60", blocks: pdGate(0.6) },
  { key: "pd70", blocks: pdGate(0.7) },
  { key: "chase06", blocks: chaseGate(0.6) },
  { key: "chase10", blocks: chaseGate(1.0) },
  {
    key: "pd60+chase06",
    blocks: (side, g) => pdGate(0.6)(side, g) || chaseGate(0.6)(side, g),
  },
];

function discoverFiles(): string[] {
  if (process.env.FILES) return process.env.FILES.split(",").map((s) => s.trim());
  return readdirSync("scripts")
    .filter((f) => /^llm-trader-wf-trades-.*\.jsonl$/.test(f))
    .map((f) => `scripts/${f}`);
}

function cohortOf(file: string): string {
  const m = basename(file).match(/-(v[0-9a-z_]+)-\d{4}-/);
  return m ? m[1] : "unknown";
}

async function main(): Promise<void> {
  const files = discoverFiles();
  if (files.length === 0) throw new Error("No trades JSONL files found (set FILES=...)");

  const corpus: Corpus = await loadCorpus("4h");
  const barIdxByDate = new Map<string, number>();
  corpus.bars.forEach((b, i) => barIdxByDate.set(b.date, i));

  interface ScreenTrade {
    cohort: string;
    side: "long" | "short";
    gate: GateInputs;
    rByGeometry: Record<string, number>;
  }
  const trades: ScreenTrade[] = [];
  let unmatched = 0;

  for (const file of files) {
    const cohort = cohortOf(file);
    const recorded = readFileSync(file, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => JSON.parse(l) as RecordedTrade);
    for (const t of recorded) {
      const entryIdx = barIdxByDate.get(t.entry_date);
      if (entryIdx === undefined || entryIdx >= corpus.bars.length - 1) {
        unmatched++;
        continue;
      }
      const regime = (t.entry_regime ?? "n/a") as "HH" | "LH" | "RANGING" | "n/a";
      const dailyAtr = dailyAtrBefore(corpus.dailyBars, t.entry_date);
      const rByGeometry: Record<string, number> = {};
      let skip = false;
      for (const geom of GEOMETRIES as Geometry[]) {
        const slDistance = computeSlForBacktest(corpus.bars, entryIdx, t.side, t.entry_price, geom.sl);
        if (slDistance <= 0) {
          skip = true;
          break;
        }
        const tpDistance = computeTpForBacktest(slDistance, t.entry_price, TP_CFG, { regime, dailyAtr });
        rByGeometry[geom.key] = simulate(t, corpus.bars, entryIdx, slDistance, tpDistance, V0).r;
      }
      if (skip) {
        unmatched++;
        continue;
      }
      trades.push({
        cohort,
        side: t.side,
        gate: gateInputsAt(corpus.bars, entryIdx, t.entry_price),
        rByGeometry,
      });
    }
  }

  const pad = (s: string, n: number): string => (s.length >= n ? s : s + " ".repeat(n - s.length));
  console.log("\n===== Entry-gate screen (zero LLM calls) =====");
  console.log(`corpus: ${trades.length} trades from ${files.length} files (${unmatched} unmatched/skipped)\n`);

  const agg = (rs: number[]): { n: number; wr: number; sumR: number; meanR: number } => ({
    n: rs.length,
    wr: rs.length ? (rs.filter((r) => r > 0).length / rs.length) * 100 : 0,
    sumR: rs.reduce((s, r) => s + r, 0),
    meanR: rs.length ? rs.reduce((s, r) => s + r, 0) / rs.length : 0,
  });

  const report: Record<string, unknown> = {};
  // Screen under the two decision-relevant geometries.
  for (const geomKey of ["comboC", "swing"]) {
    const all = agg(trades.map((t) => t.rByGeometry[geomKey]));
    console.log(
      `--- geometry ${geomKey} — ungated baseline: n=${all.n} WR=${all.wr.toFixed(0)}% sumR=${all.sumR.toFixed(1)} ($${(all.sumR * RISK_USD).toFixed(0)} @${RISK_PCT}%/$${CAPITAL / 1000}K) ---`
    );
    console.log(
      `  ${pad("gate", 14)}${pad("blocked", 9)}${pad("blkWR", 7)}${pad("blkMeanR", 10)}${pad("blockedSumR", 13)}${pad("gatedSumR", 11)}delta$`
    );
    const geomReport: Record<string, unknown> = {};
    for (const gate of GATES) {
      const blocked = trades.filter((t) => gate.blocks(t.side, t.gate));
      const kept = trades.filter((t) => !gate.blocks(t.side, t.gate));
      const b = agg(blocked.map((t) => t.rByGeometry[geomKey]));
      const k = agg(kept.map((t) => t.rByGeometry[geomKey]));
      geomReport[gate.key] = { blocked: b, kept: k };
      console.log(
        `  ${pad(gate.key, 14)}${pad(`${b.n}/${all.n}`, 9)}${pad(`${b.wr.toFixed(0)}%`, 7)}${pad(b.meanR.toFixed(2), 10)}${pad(b.sumR.toFixed(1), 13)}${pad(k.sumR.toFixed(1), 11)}${b.sumR < 0 ? "+" : ""}${(-b.sumR * RISK_USD).toFixed(0)}`
      );
    }
    report[geomKey] = geomReport;
    console.log("");
  }

  // Info-only splits: range-position and momentum quartiles + session
  // handled by the cohort report for live data. Here: blocked-overlap.
  console.log("Read: a gate earns its place only if blkMeanR is sharply negative");
  console.log("(it removes LOSERS specifically) AND blocked n is meaningful. delta$ =");
  console.log("what the gate would have added by avoidance on this corpus.");
  console.log("\nCaveats: entries fixed; no re-entry/halt knock-ons; winners still");
  console.log("need the one paid WF confirmation before any live wiring.");

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outPath = `scripts/entry-gate-screen-${stamp}.json`;
  writeFileSync(
    outPath,
    JSON.stringify(
      { risk_pct: RISK_PCT, capital: CAPITAL, files, unmatched, trades: trades.length, gates: report },
      null,
      2
    )
  );
  console.log(`\nSummary saved: ${outPath}`);
}

main().catch((err) => {
  console.error("entry-gate-screen failed:", err);
  process.exit(1);
});
