/**
 * Spread model from the Dukascopy tick corpus (E2.33 phase 1, 2026-09-02).
 *
 * Reads the gitignored tick days (via the committed sha manifest —
 * integrity-verified before use) and produces the REAL spread model the
 * 2026-10 round's friction consumes: per instrument × UTC hour, the
 * median/p75/p95 spread in absolute price units and in bps of mid, plus
 * an all-hours summary and a comparison row against the legacy catalog
 * numbers (calibrated from 37 fills in June).
 *
 * HONESTY NOTE baked into the artifact: Dukascopy raw spreads are one
 * broker's feed. The SHAPE by hour transfers across brokers; the LEVEL
 * needs a broker-specific scalar (measured at Stage 5.3 from real FTMO
 * fills). Consumers must treat `bps` columns as shape + upper-bound-ish
 * for raw-feed conditions, not as FTMO truth.
 *
 * Cross-check: each sampled day's last tick mid is compared to the
 * pinned OANDA session-day close where one exists — max deviation is
 * reported and the build REFUSES if any day diverges > 0.5% (feed
 * misalignment / decode-scale guard).
 *
 * Usage: pnpm dlx tsx scripts/canonical/build-spread-model.ts
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { loadPinnedBars } from "./lib/pinned-eval";

const TICKS_DIR = resolve(process.cwd(), "scripts/canonical/data/ticks");
const MANIFEST_PATH = resolve(process.cwd(), "scripts/canonical/data/ticks-manifest.json");
const OUT_PATH = resolve(process.cwd(), "scripts/canonical/e2-results/spread-model-2026-09.json");

const TICKER_BY_INST: Record<string, string> = {
  XAUUSD: "XAU/USD",
  EURUSD: "EUR/USD",
  GBPUSD: "GBP/USD",
  USDJPY: "USD/JPY",
};
/** Legacy catalog spread assumptions (bps) — the numbers this model replaces. */
const CATALOG_BPS: Record<string, number> = { XAUUSD: 0.4, EURUSD: 1.0, GBPUSD: 1.5, USDJPY: 1.2 };

interface Manifest {
  [inst: string]: { [day: string]: { sha256: string; ticks: number; bytes: number } };
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[idx];
}

function main(): void {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf-8")) as Manifest;
  const model: Record<string, unknown> = {};
  let worstDeviationPct = 0;
  let deviationChecks = 0;

  for (const [inst, days] of Object.entries(manifest)) {
    const ticker = TICKER_BY_INST[inst];
    // Pinned session-day closes for the cross-check (may not cover the
    // tick window's tail — only overlapping days are checked).
    let pinnedCloseByDay = new Map<string, { closeMs: number; close: number }>();
    try {
      const d = loadPinnedBars(ticker, "d");
      // Pinned D bars are session-OPEN-stamped (21:00Z prior day); the
      // session's calendar "day" for our purpose = open date + 1 day.
      // Session bar dated (D-1)T21/22:00 CLOSES at D T21/22:00 (open+24h).
      // Key by the close's calendar day, keep the exact close INSTANT so
      // the tick comparison happens at a matched moment (comparing the
      // day's LAST tick — 23:59 — against a 21:00 close was 3h of real
      // market movement and false-refused at 0.72% on 2026-03-03).
      pinnedCloseByDay = new Map(
        d.bars.map((b) => {
          const closeMs = Date.parse(b.date) + 86_400_000;
          const day = new Date(closeMs).toISOString().slice(0, 10);
          return [day, { closeMs, close: b.close }] as [string, { closeMs: number; close: number }];
        })
      );
    } catch {
      /* no pinned D file — cross-check skipped for this instrument */
    }

    // spread samples bucketed by UTC hour (subsampled: every 5th tick —
    // spreads are autocorrelated; 20% sampling keeps quantiles identical
    // at a fifth of the memory).
    const byHour: number[][] = Array.from({ length: 24 }, () => []);
    const byHourBps: number[][] = Array.from({ length: 24 }, () => []);
    let tickCount = 0;

    for (const [day, meta] of Object.entries(days)) {
      const path = resolve(TICKS_DIR, inst.toLowerCase(), `${day}.jsonl.gz`);
      const gz = readFileSync(path);
      const sha = createHash("sha256").update(gz).digest("hex");
      if (sha !== meta.sha256) {
        throw new Error(`${inst} ${day}: sha mismatch vs manifest — refusing (corpus integrity)`);
      }
      const lines = gunzipSync(gz).toString("utf-8").trimEnd().split("\n");
      const pinned = pinnedCloseByDay.get(day);
      let midAtClose = NaN;
      for (let i = 0; i < lines.length; i++) {
        const [ts, bid, ask] = JSON.parse(lines[i]) as [number, number, number];
        const mid = (bid + ask) / 2;
        if (pinned && ts <= pinned.closeMs) midAtClose = mid;
        tickCount++;
        if (i % 5 !== 0) continue;
        const hour = new Date(ts).getUTCHours();
        byHour[hour].push(ask - bid);
        byHourBps[hour].push(((ask - bid) / mid) * 10_000);
      }
      if (pinned && Number.isFinite(midAtClose)) {
        const devPct = (Math.abs(midAtClose - pinned.close) / pinned.close) * 100;
        deviationChecks++;
        worstDeviationPct = Math.max(worstDeviationPct, devPct);
        if (devPct > 0.5) {
          throw new Error(
            `${inst} ${day}: tick mid-at-session-close ${midAtClose} vs pinned OANDA close ${pinned.close} deviates ${devPct.toFixed(2)}% — feed/scale misalignment, refusing`
          );
        }
      }
    }

    const hours = byHour.map((samples, h) => {
      const s = [...samples].sort((a, b) => a - b);
      const sBps = [...byHourBps[h]].sort((a, b) => a - b);
      return {
        hour_utc: h,
        n: s.length,
        median_abs: quantile(s, 0.5),
        p75_abs: quantile(s, 0.75),
        p95_abs: quantile(s, 0.95),
        median_bps: quantile(sBps, 0.5),
        p95_bps: quantile(sBps, 0.95),
      };
    });
    const allBps = byHourBps.flat().sort((a, b) => a - b);
    model[inst] = {
      ticker,
      days: Object.keys(days).length,
      ticks: tickCount,
      overall_median_bps: quantile(allBps, 0.5),
      overall_p95_bps: quantile(allBps, 0.95),
      catalog_bps_legacy: CATALOG_BPS[inst],
      hours,
    };
    const m = model[inst] as { overall_median_bps: number };
    console.log(
      `${inst}: ${Object.keys(days).length} days, ${(tickCount / 1e6).toFixed(1)}M ticks — median spread ${m.overall_median_bps.toFixed(2)}bps (catalog assumed ${CATALOG_BPS[inst]}bps)`
    );
  }

  const artifact = {
    generated_at: new Date().toISOString(),
    source: "fetch-dukascopy-ticks.ts corpus (sha-verified vs ticks-manifest.json)",
    honesty:
      "Dukascopy raw feed. Hour-of-day SHAPE transfers across brokers; LEVEL requires broker-specific scaling (Stage 5.3 real-fill measurement). Not FTMO truth.",
    cross_check: {
      days_checked_vs_pinned_oanda_close: deviationChecks,
      worst_deviation_pct: Number(worstDeviationPct.toFixed(4)),
      refusal_threshold_pct: 0.5,
    },
    instruments: model,
  };
  writeFileSync(OUT_PATH, JSON.stringify(artifact, null, 1));
  console.log(`\nSpread model written: ${OUT_PATH}`);
  console.log(
    `Cross-check: ${deviationChecks} days vs pinned OANDA closes, worst deviation ${worstDeviationPct.toFixed(3)}%`
  );
}

main();
