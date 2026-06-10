/**
 * Exit-mechanics replay — $0 screening of Phase-1 active-management
 * variants over RECORDED walk-forward trades. Zero LLM calls.
 *
 * Premise: entry quality is the LLM's job; exit mechanics (SL/TP, BE,
 * partials, max-hold) are ENGINE policy. Given the same recorded entries
 * (bar, side, fill price), variant exit rules can be simulated directly
 * over cached price bars. This ranks the Phase-1 candidates for free so
 * the single paid confirmation run only tests the winner.
 *
 * Method:
 *  - Parse recorded trades from llm-trader-wf-trades-*.jsonl files
 *    (cohorts by prompt version: v2 / v2_mtf / v2_generic).
 *  - For each trade, recompute the live SL/TP geometry at the entry bar
 *    (swing_anchor 0.25 / lookback 8; adaptive rr_multiple 3 with the
 *    RANGING→1.5R rule + daily-ATR cap) and walk bars forward under each
 *    variant's exit rules.
 *  - FIDELITY CHECK: variant v0 must reproduce the recorded outcome for
 *    trades that exited via pure SL/TP. If fidelity is poor, the replay
 *    mechanics diverge from the harness and the ranking can't be trusted.
 *
 * Known limits (printed with results):
 *  - Entries are held fixed — variants can't change what the LLM would
 *    have entered next (consec-halt knock-ons ignored).
 *  - Recorded mid-trade LLM exits only transfer in the *_llm variants,
 *    and only at their recorded bar; under different mechanics the LLM
 *    might have decided differently. Treat v0 vs v0_llm as the
 *    sensitivity band, not a point estimate.
 *
 * Usage:
 *   pnpm dlx tsx scripts/exit-mechanics-replay.ts
 *   FILES=path1.jsonl,path2.jsonl  — explicit corpus (default: glob
 *                                    scripts/llm-trader-wf-trades-*.jsonl)
 *   RISK_PCT=0.75  CAPITAL=100000  — $ scaling for the report only
 */
import { readdirSync, readFileSync, writeFileSync } from "fs";
import { basename } from "path";
import {
  computeSlForBacktest,
  computeTpForBacktest,
  loadCorpus,
  type Corpus,
} from "./llm-trader-backtest";
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

// TP is rr_multiple 3 with the adaptive ctx (RANGING→1.5R + daily-ATR
// cap) for every geometry — verified from recorded TP distances (1.74%
// to a 4.5% ceiling), which only the ATR-capped rr model produces.
const TP_CFG = { type: "rr_multiple" as const, value: 3 };

/** SL geometries to screen. Recorded provenance (inferred from the trades
 *  themselves — stop distances are the actual stops):
 *  - v2_mtf + v2_generic runs used the harness env-default pct15 (every
 *    recorded stop exactly 1.5%) → pct15:v0 is the fidelity reference.
 *  - v2 files are the 2026-05-18 SL-sweep combos (varying sub-1.5%
 *    swing-anchor stops).
 *  Screening geometries on the SAME entries gives the stalled paid SL
 *  sweep a $0 first-pass answer; comboC was its leader through W1+W2. */
interface Geometry {
  key: string;
  sl: { type: "percentage" | "swing_anchor"; value: number; lookback?: number };
}
const GEOMETRIES: Geometry[] = [
  { key: "pct15", sl: { type: "percentage", value: 0.015 } },
  { key: "swing", sl: { type: "swing_anchor", value: 0.25, lookback: 8 } }, // live config
  { key: "comboC", sl: { type: "swing_anchor", value: 0.1, lookback: 4 } }, // sweep leader
];

interface RecordedTrade {
  side: "long" | "short";
  entry_price: number;
  exit_price: number;
  entry_date: string;
  exit_date: string;
  exit_reason: string;
  entry_regime?: string;
  r_multiple?: number;
}

interface VariantCfg {
  key: string;
  honorLlmExits: boolean;
  beAtR: number | null; // move SL to entry once +N R touched
  maxHoldBars: number | null; // force close at bar close after N bars
  partial: { atR: number; fraction: number; beAfter: boolean } | null;
}

const MECHANICS: VariantCfg[] = [
  { key: "v0", honorLlmExits: false, beAtR: null, maxHoldBars: null, partial: null },
  { key: "v0_llm", honorLlmExits: true, beAtR: null, maxHoldBars: null, partial: null },
  { key: "be1r", honorLlmExits: false, beAtR: 1, maxHoldBars: null, partial: null },
  { key: "mh24", honorLlmExits: false, beAtR: null, maxHoldBars: 24, partial: null },
  {
    key: "pt50_1r",
    honorLlmExits: false,
    beAtR: null,
    maxHoldBars: null,
    partial: { atR: 1, fraction: 0.5, beAfter: true },
  },
];

interface GridCell {
  key: string;
  geom: Geometry;
  mech: VariantCfg;
}
const GRID: GridCell[] = GEOMETRIES.flatMap((geom) =>
  MECHANICS.map((mech) => ({ key: `${geom.key}:${mech.key}`, geom, mech }))
);

interface SimOutcome {
  r: number;
  holdBars: number;
  exitReason: string;
}

/** ATR(14) over daily bars strictly before `dateStr` — feeds the
 *  adaptive-TP cap the same way the harness does at entry time. */
function dailyAtrBefore(dailyBars: PriceBar[], dateStr: string): number {
  const day = dateStr.slice(0, 10);
  let end = dailyBars.length - 1;
  while (end > 0 && dailyBars[end].date.slice(0, 10) >= day) end--;
  if (end < 15) return 0;
  let trSum = 0;
  for (let i = end - 13; i <= end; i++) {
    const tr = Math.max(
      dailyBars[i].high - dailyBars[i].low,
      Math.abs(dailyBars[i].high - dailyBars[i - 1].close),
      Math.abs(dailyBars[i].low - dailyBars[i - 1].close)
    );
    trSum += tr;
  }
  return trSum / 14;
}

/** Walk bars forward from entry under one variant's exit rules.
 *  Same-bar ambiguity is resolved SL-first (conservative — mirrors
 *  findExitOnNextBar in the harness). BE moves apply at bar CLOSE, so a
 *  bar that touches +1R and then reverses through entry still exits at
 *  the ORIGINAL stop that bar (conservative). */
function simulate(
  trade: RecordedTrade,
  bars: PriceBar[],
  entryIdx: number,
  slDistance: number,
  tpDistance: number,
  v: VariantCfg
): SimOutcome {
  const dir = trade.side === "long" ? 1 : -1;
  const entry = trade.entry_price;
  let stop = entry - dir * slDistance;
  const target = entry + dir * tpDistance;
  const partialTarget = v.partial ? entry + dir * v.partial.atR * slDistance : null;
  const beTrigger = v.beAtR !== null ? entry + dir * v.beAtR * slDistance : null;

  let openFraction = 1;
  let bankedR = 0;
  let partialFilled = false;
  let beMoved = false;

  const rAt = (price: number): number => (dir * (price - entry)) / slDistance;

  for (let i = entryIdx + 1; i < bars.length; i++) {
    const bar = bars[i];
    const held = i - entryIdx;
    const hitsStop = trade.side === "long" ? bar.low <= stop : bar.high >= stop;
    const hitsTarget = trade.side === "long" ? bar.high >= target : bar.low <= target;
    const hitsPartial =
      partialTarget !== null &&
      !partialFilled &&
      (trade.side === "long" ? bar.high >= partialTarget : bar.low <= partialTarget);

    // 1. SL first — conservative same-bar resolution.
    if (hitsStop) {
      return {
        r: bankedR + openFraction * rAt(stop),
        holdBars: held,
        exitReason: beMoved || partialFilled ? "stop_be" : "stop_loss",
      };
    }
    // 2. Partial target (before full target by construction: atR < rr).
    if (hitsPartial && v.partial) {
      bankedR += v.partial.fraction * v.partial.atR;
      openFraction -= v.partial.fraction;
      partialFilled = true;
      if (v.partial.beAfter) stop = entry;
    }
    // 3. Full target.
    if (hitsTarget) {
      return {
        r: bankedR + openFraction * rAt(target),
        holdBars: held,
        exitReason: "take_profit",
      };
    }
    // 4. Recorded LLM exit (only in *_llm variants, at its recorded bar).
    // Harness records these as "llm_exit"; live uses "exit_signal".
    if (
      v.honorLlmExits &&
      (trade.exit_reason === "llm_exit" || trade.exit_reason === "exit_signal") &&
      bar.date === trade.exit_date
    ) {
      return {
        r: bankedR + openFraction * rAt(trade.exit_price),
        holdBars: held,
        exitReason: "exit_signal",
      };
    }
    // 5. Max-hold cut at bar close.
    if (v.maxHoldBars !== null && held >= v.maxHoldBars) {
      return {
        r: bankedR + openFraction * rAt(bar.close),
        holdBars: held,
        exitReason: "max_hold",
      };
    }
    // 6. BE move at bar close (after exit checks — conservative).
    if (beTrigger !== null && !beMoved) {
      const touched = trade.side === "long" ? bar.high >= beTrigger : bar.low <= beTrigger;
      if (touched) {
        stop = entry;
        beMoved = true;
      }
    }
  }
  const last = bars[bars.length - 1];
  return {
    r: bankedR + openFraction * rAt(last.close),
    holdBars: bars.length - 1 - entryIdx,
    exitReason: "end_of_data",
  };
}

interface CohortFile {
  cohort: string;
  file: string;
  trades: RecordedTrade[];
}

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

  const cohortFiles: CohortFile[] = files.map((file) => ({
    cohort: cohortOf(file),
    file,
    trades: readFileSync(file, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => JSON.parse(l) as RecordedTrade),
  }));

  let unmatched = 0;
  let fidelityChecked = 0;
  let fidelityOk = 0;

  interface SimTrade {
    cohort: string;
    file: string;
    entryDate: string;
    regime: string;
    recordedR: number | null;
    recordedReason: string;
    byVariant: Record<string, SimOutcome>;
  }
  const simTrades: SimTrade[] = [];

  for (const cf of cohortFiles) {
    for (const t of cf.trades) {
      const entryIdx = barIdxByDate.get(t.entry_date);
      if (entryIdx === undefined || entryIdx >= corpus.bars.length - 1) {
        unmatched++;
        continue;
      }
      const regime = (t.entry_regime ?? "n/a") as "HH" | "LH" | "RANGING" | "n/a";
      const dailyAtr = dailyAtrBefore(corpus.dailyBars, t.entry_date);

      const byVariant: Record<string, SimOutcome> = {};
      let skip = false;
      for (const cell of GRID) {
        const slDistance = computeSlForBacktest(
          corpus.bars,
          entryIdx,
          t.side,
          t.entry_price,
          cell.geom.sl
        );
        if (slDistance <= 0) {
          skip = true;
          break;
        }
        const tpDistance = computeTpForBacktest(slDistance, t.entry_price, TP_CFG, {
          regime,
          dailyAtr,
        });
        byVariant[cell.key] = simulate(
          t,
          corpus.bars,
          entryIdx,
          slDistance,
          tpDistance,
          cell.mech
        );
      }
      if (skip) {
        unmatched++;
        continue;
      }

      // Fidelity: pct15:v0 vs recorded, on cohorts whose recorded runs
      // used the pct15 geometry (v2_mtf / v2_generic — verified from the
      // recorded stop distances). The v2 sweep files ran other geometries,
      // so they can't serve as a mechanics reference.
      const fidelityCohort = cf.cohort === "v2_mtf" || cf.cohort === "v2_generic";
      if (fidelityCohort && (t.exit_reason === "stop_loss" || t.exit_reason === "take_profit")) {
        fidelityChecked++;
        if (byVariant["pct15:v0"].exitReason === t.exit_reason) fidelityOk++;
      }

      simTrades.push({
        cohort: cf.cohort,
        file: cf.file,
        entryDate: t.entry_date,
        regime,
        recordedR: t.r_multiple ?? null,
        recordedReason: t.exit_reason,
        byVariant,
      });
    }
  }

  // ---- Report ----
  const pad = (s: string, n: number): string => (s.length >= n ? s : s + " ".repeat(n - s.length));
  const cohorts = [...new Set(simTrades.map((s) => s.cohort))].sort();

  console.log("\n===== Exit-mechanics replay (zero LLM calls) =====");
  console.log(
    `corpus: ${simTrades.length} trades from ${files.length} files (${unmatched} unmatched/skipped)`
  );
  console.log(
    `fidelity: pct15:v0 reproduced recorded SL/TP exits on ${fidelityOk}/${fidelityChecked} ` +
      `(${fidelityChecked ? ((fidelityOk / fidelityChecked) * 100).toFixed(0) : 0}%) ` +
      `[config-matched cohorts only] — below ~85% means replay mechanics diverge; distrust the ranking.`
  );

  interface Row {
    variant: string;
    n: number;
    wr: number;
    sumR: number;
    meanR: number;
    medHold: number;
    worstSeqDdR: number;
    usd: number;
  }

  function rowsFor(trades: SimTrade[]): Row[] {
    return GRID.map((v) => {
      const outs = trades.map((s) => ({ ...s.byVariant[v.key], entryDate: s.entryDate, file: s.file }));
      const n = outs.length;
      const wins = outs.filter((o) => o.r > 0).length;
      const sumR = outs.reduce((s, o) => s + o.r, 0);
      const holds = outs.map((o) => o.holdBars).sort((a, b) => a - b);
      // Worst per-file sequential drawdown in R (each file = one rep).
      let worstSeqDdR = 0;
      for (const file of new Set(outs.map((o) => o.file))) {
        const seq = outs
          .filter((o) => o.file === file)
          .sort((a, b) => a.entryDate.localeCompare(b.entryDate));
        let eq = 0;
        let peak = 0;
        for (const o of seq) {
          eq += o.r;
          peak = Math.max(peak, eq);
          worstSeqDdR = Math.max(worstSeqDdR, peak - eq);
        }
      }
      return {
        variant: v.key,
        n,
        wr: n ? (wins / n) * 100 : 0,
        sumR,
        meanR: n ? sumR / n : 0,
        medHold: holds.length ? holds[Math.floor(holds.length / 2)] : 0,
        worstSeqDdR,
        usd: sumR * RISK_USD,
      };
    }).sort((a, b) => b.sumR - a.sumR);
  }

  function printTable(label: string, trades: SimTrade[]): void {
    console.log(`\n--- ${label} (n=${trades.length}) ---`);
    console.log(
      `  ${pad("variant", 16)}${pad("WR", 7)}${pad("sumR", 9)}${pad("meanR", 9)}${pad("medHold", 9)}${pad("worstDD(R)", 12)}$@${RISK_PCT}%/$${CAPITAL / 1000}K`
    );
    for (const r of rowsFor(trades)) {
      console.log(
        `  ${pad(r.variant, 16)}${pad(`${r.wr.toFixed(0)}%`, 7)}${pad(r.sumR.toFixed(1), 9)}${pad(r.meanR.toFixed(2), 9)}${pad(r.medHold.toString(), 9)}${pad(r.worstSeqDdR.toFixed(1), 12)}$${r.usd.toFixed(0)}`
      );
    }
  }

  for (const c of cohorts) {
    printTable(`cohort ${c}`, simTrades.filter((s) => s.cohort === c));
  }
  printTable("ALL cohorts combined", simTrades);

  console.log("\nCaveats:");
  console.log("  - Entries held fixed; variants cannot change subsequent entry behavior.");
  console.log("  - Recorded LLM mid-trade exits transfer only in *_llm variants, at their");
  console.log("    recorded bar. v0 vs v0_llm is the sensitivity band for that unknown.");
  console.log("  - One paid WF confirmation run on the winning variant is still required");
  console.log("    before any live config change.");

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outPath = `scripts/exit-replay-summary-${stamp}.json`;
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        risk_pct: RISK_PCT,
        capital: CAPITAL,
        geometries: GEOMETRIES,
        tp_cfg: TP_CFG,
        files,
        unmatched,
        fidelity: { checked: fidelityChecked, ok: fidelityOk },
        by_cohort: Object.fromEntries(
          cohorts.map((c) => [c, rowsFor(simTrades.filter((s) => s.cohort === c))])
        ),
        combined: rowsFor(simTrades),
      },
      null,
      2
    )
  );
  console.log(`\nSummary saved: ${outPath}`);
}

main().catch((err) => {
  console.error("exit-mechanics-replay failed:", err);
  process.exit(1);
});
