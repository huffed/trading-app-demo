/**
 * Structural-TP screen — $0, zero LLM calls.
 *
 * Operator question (from the friend's practice): instead of geometric
 * RR targets, should TP sit at LIQUIDITY LEVELS — "target the Asia
 * high", prior day's extreme, the opposing swing point? Price runs to
 * where stops cluster; an RR multiple is indifferent to that map.
 *
 * Method: same machinery as the short-geometry screen — the 4h recorded
 * entries and comboC structural SL are FIXED; only the TP rule varies.
 * Each structural variant falls back to the live RR rule (rr3 long /
 * rr1.5 short) when no valid level exists beyond entry, so every
 * variant is deployable-as-screened. TP floors at 1×SL (the engine's
 * RR≥1 floor) for fairness with production.
 *
 * Variants:
 *   live_rr        — rr3 longs / rr1.5 shorts (current production)
 *   swing_target   — last confirmed 4h swing high above entry (longs) /
 *                    swing low below (shorts), lookback 5
 *   prior_day      — previous UTC day's high (longs) / low (shorts)
 *   asia_range     — that day's 00:00-07:59Z range high (longs) / low
 *                    (shorts) from 1h bars; previous day's when entry
 *                    is before 08:00Z
 *
 * Verdict rule (operator, 2026-06-12): if structural TP screens
 * negative vs the live RR config, drop the idea — no further spend.
 *
 * Usage:
 *   pnpm dlx tsx scripts/structural-tp-screen.ts
 *   FILES=a.jsonl,b.jsonl   explicit corpora (default: glob 4h trades)
 */
import { readdirSync, readFileSync } from "fs";
import { detectSwingPoints } from "../src/lib/patterns/swing-points";
import type { PriceBar } from "../src/lib/market-data/types";
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
const COMBO_C = { type: "swing_anchor" as const, value: 0.1, lookback: 4 };
const RR_LONG = 3;
const RR_SHORT = 1.5;

function discoverFiles(): string[] {
  if (process.env.FILES) return process.env.FILES.split(",").map((s) => s.trim());
  return readdirSync("scripts")
    .filter((f) => /^llm-trader-wf-trades-.*-4h-.*\.jsonl$/.test(f))
    .map((f) => `scripts/${f}`);
}

interface LevelResult {
  /** TP distance in price units, or null = no valid level (fallback). */
  distance: number | null;
}

async function main(): Promise<void> {
  const files = discoverFiles();
  if (files.length === 0) throw new Error("No 4h trades JSONLs found (set FILES=...)");

  const corpus: Corpus = await loadCorpus("4h");
  const corpus1h: Corpus = await loadCorpus("1h");
  const bars = corpus.bars;
  const barIdxByDate = new Map<string, number>();
  bars.forEach((b, i) => barIdxByDate.set(b.date, i));
  const swings = detectSwingPoints(bars, 5);

  // Daily extremes by UTC day key, from native daily bars.
  const dayHigh = new Map<string, number>();
  const dayLow = new Map<string, number>();
  const dayKeys: string[] = [];
  for (const d of corpus.dailyBars) {
    const k = d.date.slice(0, 10);
    dayHigh.set(k, d.high);
    dayLow.set(k, d.low);
    dayKeys.push(k);
  }

  // Asia range (00:00-07:59Z) per UTC day, from 1h bars.
  const asiaHigh = new Map<string, number>();
  const asiaLow = new Map<string, number>();
  for (const b of corpus1h.bars) {
    const hour = Number(b.date.slice(11, 13));
    if (hour >= 8) continue;
    const k = b.date.slice(0, 10);
    asiaHigh.set(k, Math.max(asiaHigh.get(k) ?? -Infinity, b.high));
    asiaLow.set(k, Math.min(asiaLow.get(k) ?? Infinity, b.low));
  }

  const priorDayKey = (entryDate: string): string | null => {
    const k = entryDate.slice(0, 10);
    // dayKeys ascending; find the last key strictly before k.
    let prev: string | null = null;
    for (const dk of dayKeys) {
      if (dk >= k) break;
      prev = dk;
    }
    return prev;
  };

  type LevelFn = (t: RecordedTrade, idx: number) => LevelResult;

  const swingTarget: LevelFn = (t, idx) => {
    // Most recent CONFIRMED swing beyond entry price, looking back from
    // the entry bar. Confirmation needs +lookback future bars, so only
    // swings with idx <= entryIdx - 5 are known at entry (no lookahead).
    for (let i = swings.length - 1; i >= 0; i--) {
      const s = swings[i];
      if (s.idx > idx - 5) continue;
      if (t.side === "long" && s.type === "high" && s.price > t.entry_price) {
        return { distance: s.price - t.entry_price };
      }
      if (t.side === "short" && s.type === "low" && s.price < t.entry_price) {
        return { distance: t.entry_price - s.price };
      }
    }
    return { distance: null };
  };

  const priorDay: LevelFn = (t) => {
    const pk = priorDayKey(t.entry_date);
    if (!pk) return { distance: null };
    const level = t.side === "long" ? dayHigh.get(pk) : dayLow.get(pk);
    if (level === undefined) return { distance: null };
    const d = t.side === "long" ? level - t.entry_price : t.entry_price - level;
    return { distance: d > 0 ? d : null };
  };

  const asiaRange: LevelFn = (t) => {
    const hour = Number(t.entry_date.slice(11, 13));
    const k = hour >= 8 ? t.entry_date.slice(0, 10) : priorDayKey(t.entry_date);
    if (!k) return { distance: null };
    const level = t.side === "long" ? asiaHigh.get(k) : asiaLow.get(k);
    if (level === undefined || !Number.isFinite(level)) return { distance: null };
    const d = t.side === "long" ? level - t.entry_price : t.entry_price - level;
    return { distance: d > 0 ? d : null };
  };

  const VARIANTS: { key: string; level: LevelFn | null }[] = [
    { key: "live_rr (rr3/rr1.5)", level: null },
    { key: "swing_target", level: swingTarget },
    { key: "prior_day", level: priorDay },
    { key: "asia_range", level: asiaRange },
  ];

  // Dedupe recorded trades across reps.
  const seen = new Set<string>();
  const trades: (RecordedTrade & { entry_regime?: string })[] = [];
  for (const file of files) {
    for (const line of readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean)) {
      const t = JSON.parse(line) as RecordedTrade & { entry_regime?: string };
      const k = `${t.entry_date}|${t.side}`;
      if (seen.has(k)) continue;
      seen.add(k);
      trades.push(t);
    }
  }

  const agg = (rs: number[]): string => {
    const n = rs.length;
    if (n === 0) return "n=0";
    const sum = rs.reduce((a, b) => a + b, 0);
    const wr = (rs.filter((r) => r > 0).length / n) * 100;
    return `n=${n} WR=${wr.toFixed(0).padStart(3)}% meanR=${(sum / n).toFixed(2)} sumR=${sum.toFixed(1)}`;
  };

  console.log("\n===== Structural-TP screen (zero LLM calls) =====");
  console.log(
    `corpus: ${trades.length} deduped trades from ${files.length} files · SL fixed comboC · fallback rr3/rr1.5 when no level\n`
  );

  for (const side of ["long", "short"] as const) {
    const subset = trades.filter((t) => t.side === side);
    console.log(`${side.toUpperCase()}S (n=${subset.length}):`);
    for (const v of VARIANTS) {
      const rs: number[] = [];
      let levelUsed = 0;
      for (const t of subset) {
        const idx = barIdxByDate.get(t.entry_date);
        if (idx === undefined || idx >= bars.length - 2) continue;
        const slDistance = computeSlForBacktest(bars, idx, t.side, t.entry_price, COMBO_C);
        if (slDistance <= 0) continue;
        const rrFallback = computeTpForBacktest(
          slDistance,
          t.entry_price,
          { type: "rr_multiple", value: side === "long" ? RR_LONG : RR_SHORT },
          {
            regime: (t.entry_regime ?? "n/a") as Regime,
            dailyAtr: dailyAtrBefore(corpus.dailyBars, t.entry_date),
          }
        );
        let tpDistance = rrFallback;
        if (v.level) {
          const lr = v.level(t, idx);
          if (lr.distance !== null) {
            // Engine's RR>=1 floor for fairness with production.
            tpDistance = Math.max(lr.distance, slDistance);
            levelUsed++;
          }
        }
        rs.push(simulate(t, bars, idx, slDistance, tpDistance, V0).r);
      }
      const coverage = v.level ? ` (level used ${levelUsed}/${rs.length})` : "";
      console.log(`  ${v.key.padEnd(22)} ${agg(rs)}${coverage}`);
    }
    console.log("");
  }

  console.log("Read: variants fall back to live RR when no level exists beyond entry,");
  console.log("so each row is deployable-as-screened. Negative vs live_rr = drop the");
  console.log("idea (operator rule, 2026-06-12). Caveats: 4h-frame levels; v0 mechanics;");
  console.log("Asia range needs 1h history (trades before Aug 2025 fall back).");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
