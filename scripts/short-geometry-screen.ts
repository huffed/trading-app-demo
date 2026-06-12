/**
 * Short-geometry screen — $0, zero LLM calls.
 *
 * Hypothesis (from replay-shorts-asymmetric-sl.ts, May 7, never
 * productionized): gold falls faster than it rises, so SHORTS may want
 * different SL/TP geometry than the symmetric comboC the engine applies
 * to both sides. This replays every recorded SHORT trade from the 4h
 * walk-forward corpora through a geometry grid and compares R.
 *
 * Method: same machinery as the hold-side screen — recorded entries
 * fixed, v0 mechanics (no LLM exits), per-variant SL/TP recomputed at
 * the entry bar. LONG trades replayed through comboC once as the
 * reference frame.
 *
 * Usage:
 *   pnpm dlx tsx scripts/short-geometry-screen.ts
 *   FILES=a.jsonl,b.jsonl   explicit corpora (default: glob 4h trades)
 */
import { readdirSync, readFileSync } from "fs";
import { dailyAtrBefore, simulate, type RecordedTrade, type VariantCfg } from "./exit-mechanics-replay";
import {
  computeSlForBacktest,
  computeTpForBacktest,
  loadCorpus,
  type Corpus,
  type Regime,
} from "./llm-trader-backtest";

const V0: VariantCfg = {
  key: "v0",
  honorLlmExits: false,
  beAtR: null,
  maxHoldBars: null,
  partial: null,
};

interface GeometryVariant {
  key: string;
  sl: { type: "percentage" | "swing_anchor"; value: number; lookback?: number };
  rr: number;
}

const VARIANTS: GeometryVariant[] = [
  { key: "comboC_rr3 (live)", sl: { type: "swing_anchor", value: 0.1, lookback: 4 }, rr: 3 },
  { key: "comboC_rr2", sl: { type: "swing_anchor", value: 0.1, lookback: 4 }, rr: 2 },
  { key: "comboC_rr1.5", sl: { type: "swing_anchor", value: 0.1, lookback: 4 }, rr: 1.5 },
  { key: "tight_0.05/3_rr3", sl: { type: "swing_anchor", value: 0.05, lookback: 3 }, rr: 3 },
  { key: "tight_0.05/3_rr2", sl: { type: "swing_anchor", value: 0.05, lookback: 3 }, rr: 2 },
  { key: "wide_0.25/8_rr3", sl: { type: "swing_anchor", value: 0.25, lookback: 8 }, rr: 3 },
];

function discoverFiles(): string[] {
  if (process.env.FILES) return process.env.FILES.split(",").map((s) => s.trim());
  return readdirSync("scripts")
    .filter((f) => /^llm-trader-wf-trades-.*-4h-.*\.jsonl$/.test(f))
    .map((f) => `scripts/${f}`);
}

async function main(): Promise<void> {
  const files = discoverFiles();
  if (files.length === 0) throw new Error("No 4h trades JSONLs found (set FILES=...)");

  const corpus: Corpus = await loadCorpus("4h");
  const bars = corpus.bars;
  const barIdxByDate = new Map<string, number>();
  bars.forEach((b, i) => barIdxByDate.set(b.date, i));

  // Dedupe recorded trades by (entry_date, side) across reps.
  const seen = new Set<string>();
  const trades: RecordedTrade[] = [];
  for (const file of files) {
    for (const line of readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean)) {
      const t = JSON.parse(line) as RecordedTrade & { entry_regime?: string };
      const k = `${t.entry_date}|${t.side}`;
      if (seen.has(k)) continue;
      seen.add(k);
      trades.push(t);
    }
  }
  const shorts = trades.filter((t) => t.side === "short");
  const longs = trades.filter((t) => t.side === "long");

  const agg = (rs: number[]): string => {
    const n = rs.length;
    if (n === 0) return "n=0";
    const sum = rs.reduce((a, b) => a + b, 0);
    const wr = (rs.filter((r) => r > 0).length / n) * 100;
    return `n=${n} WR=${wr.toFixed(0)}% meanR=${(sum / n).toFixed(2)} sumR=${sum.toFixed(1)}`;
  };

  const replay = (subset: RecordedTrade[], v: GeometryVariant): number[] => {
    const rs: number[] = [];
    for (const t of subset) {
      const idx = barIdxByDate.get(t.entry_date);
      if (idx === undefined || idx >= bars.length - 2) continue;
      const slDistance = computeSlForBacktest(bars, idx, t.side, t.entry_price, {
        type: v.sl.type,
        value: v.sl.value,
        lookback: v.sl.lookback,
      });
      if (slDistance <= 0) continue;
      const tpDistance = computeTpForBacktest(
        slDistance,
        t.entry_price,
        { type: "rr_multiple", value: v.rr },
        {
          regime: ((t as { entry_regime?: string }).entry_regime ?? "n/a") as Regime,
          dailyAtr: dailyAtrBefore(corpus.dailyBars, t.entry_date),
        }
      );
      rs.push(simulate(t, bars, idx, slDistance, tpDistance, V0).r);
    }
    return rs;
  };

  console.log("\n===== Short-geometry screen (zero LLM calls) =====");
  console.log(
    `corpus: ${trades.length} deduped trades from ${files.length} files — ${shorts.length} shorts / ${longs.length} longs\n`
  );
  console.log("SHORTS by geometry:");
  for (const v of VARIANTS) {
    console.log(`  ${v.key.padEnd(20)} ${agg(replay(shorts, v))}`);
  }
  console.log("\nLONGS reference (live comboC_rr3):");
  console.log(`  ${"comboC_rr3 (live)".padEnd(20)} ${agg(replay(longs, VARIANTS[0]))}`);
  console.log(
    "\nRead: if a short variant beats comboC_rr3 on meanR at comparable WR,\nasymmetric per-side geometry is worth a confirmation; otherwise the\nsymmetric live config stands."
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
