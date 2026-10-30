/**
 * /regime-report — read-only regime summary from the PINNED XAU/USD corpora.
 *
 *   pnpm exec tsx scripts/regime-report.ts            # defaults: last 90 H4 bars, last 60 session days
 *   pnpm exec tsx scripts/regime-report.ts 200 120    # bars, days
 *
 * Reads scripts/canonical/data/*-pinned.json only (sha re-hashed on load); no
 * database, no broker, no network. Two views the engine itself uses:
 *   - the H.6 vol-percentile regime per H4 bar (ATR(14) tercile over 200 bars,
 *     `src/lib/algorithm/regime-classifier.ts`), as a distribution;
 *   - the daily bias (D1 close vs SMA20, `src/lib/patterns/daily-bias.ts`) per
 *     session day, with every flip listed.
 */
import { classifyAllBars, type Regime } from "@/lib/algorithm/regime-classifier";
import type { PriceBar } from "@/lib/market-data/types";
import { detectDailyBias } from "@/lib/patterns/daily-bias";
import { loadPinnedBars, sessionDailyClose } from "./canonical/lib/pinned-eval";

const TICKER = "XAU/USD";

interface Distribution {
  total: number;
  classified: number;
  counts: Record<Regime, number>;
}

function distribution(regimes: (Regime | null)[]): Distribution {
  const counts: Record<Regime, number> = { low_vol: 0, medium_vol: 0, high_vol: 0 };
  let classified = 0;
  for (const r of regimes) {
    if (r === null) continue;
    counts[r] += 1;
    classified += 1;
  }
  return { total: regimes.length, classified, counts };
}

function pct(n: number, of: number): string {
  return of === 0 ? "n/a" : `${((100 * n) / of).toFixed(1)}%`;
}

function printDistribution(label: string, d: Distribution): void {
  console.log(`\n${label}: ${String(d.classified)} classified of ${String(d.total)} bars`);
  for (const r of ["low_vol", "medium_vol", "high_vol"] as const) {
    console.log(
      `  ${r.padEnd(11)} ${String(d.counts[r]).padStart(5)}  ${pct(d.counts[r], d.classified)}`
    );
  }
}

type Bias = "bullish" | "bearish" | "neutral";

function biasOn(daily: PriceBar[], endIdxInclusive: number): Bias {
  const result = detectDailyBias(daily.slice(0, endIdxInclusive + 1));
  return result.details?.bias ?? "neutral";
}

function printBias(daily: PriceBar[], days: number): void {
  const start = Math.max(20, daily.length - days);
  const flips: string[] = [];
  let prev = biasOn(daily, start - 1);
  for (let i = start; i < daily.length; i++) {
    const b = biasOn(daily, i);
    if (b !== prev) {
      flips.push(`${daily[i].date.slice(0, 10)}: ${prev} → ${b}`);
      prev = b;
    }
  }
  const last = daily[daily.length - 1];
  console.log(
    `\nDaily bias (D1 close vs SMA20) on ${last.date.slice(0, 10)}: ${biasOn(daily, daily.length - 1)}`
  );
  console.log(
    `  flips in the last ${String(days)} session days: ${flips.length === 0 ? "none" : String(flips.length)}`
  );
  for (const f of flips) console.log(`    ${f}`);
}

function main(): number {
  const bars = Number(process.argv[2] ?? "90");
  const days = Number(process.argv[3] ?? "60");
  if (!Number.isFinite(bars) || !Number.isFinite(days) || bars < 1 || days < 1) {
    console.error("usage: regime-report.ts [h4-bars] [session-days]");
    return 2;
  }
  const h4 = loadPinnedBars(TICKER, "h4");
  const d1 = loadPinnedBars(TICKER, "d");
  const daily = sessionDailyClose(d1.bars);
  const first = h4.bars[0];
  const lastBar = h4.bars[h4.bars.length - 1];
  console.log(
    `${TICKER} pinned H4: ${String(h4.bars.length)} bars, ${first.date} → ${lastBar.date}`
  );
  console.log(`  h4 sha256 ${h4.sha256.slice(0, 12)}…  d sha256 ${d1.sha256.slice(0, 12)}…`);

  const regimes = classifyAllBars(h4.bars);
  printDistribution("Vol regime, whole pin", distribution(regimes));
  printDistribution(`Vol regime, last ${String(bars)} H4 bars`, distribution(regimes.slice(-bars)));
  const current = regimes[regimes.length - 1];
  console.log(`  current regime on the last pinned bar: ${current ?? "unknown (lookback < 200)"}`);

  printBias(daily, days);
  console.log(
    "\nThe pin ends where it ends: this is the corpus the verdicts were derived on, not live data."
  );
  return 0;
}

process.exit(main());
