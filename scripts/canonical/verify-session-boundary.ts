/**
 * E2.25.b — proves the session-close daily boundary as the ENGINE now
 * aligns it (instant alignment on close-instant-stamped session bars):
 *  (1) eliminates the ~8% UTC-day-vs-NY-session daily_bias divergence,
 *  (2) is exactly leak-free (every aligned session closes ≤ the decision).
 * Run: pnpm dlx tsx scripts/canonical/verify-session-boundary.ts
 */
import { loadPinnedBars, sessionDailyClose } from "./lib/pinned-eval";
import { alignBarIndex, alignCompletedDailyIndex, resampleToDaily } from "../../src/lib/market-data/resample";
import { detectDailyBias } from "../../src/lib/patterns/daily-bias";
import type { PriceBar } from "../../src/lib/market-data/types";

function bias(daily: PriceBar[], dIdx: number): string {
  if (dIdx < 0) return "flat";
  const r = detectDailyBias(daily.slice(0, dIdx + 1), 20);
  return !r.detected || !r.details ? "flat" : r.details.bias;
}

const { bars: h4 } = loadPinnedBars("XAU/USD", "h4");
const { bars: dRaw } = loadPinnedBars("XAU/USD", "d");
const utcDaily = resampleToDaily(h4);           // legacy UTC-day (leaky-boundary source)
const sessClose = sessionDailyClose(dRaw);       // close-instant-stamped sessions (ENGINE input)

let leak = 0, total = 0, divUtcVsSession = 0;
for (let i = 200; i < h4.length; i++) {
  const asOf = h4[i].date, asOfMs = Date.parse(asOf);
  // ENGINE path for close-stamped bars = alignBarIndex (instant ≤).
  const engIdx = alignBarIndex(sessClose, asOf);
  // Legacy UTC-day path = alignCompletedDailyIndex.
  const legIdx = alignCompletedDailyIndex(utcDaily, asOf);
  if (engIdx >= 0 && Date.parse(sessClose[engIdx].date) > asOfMs) leak++; // must be 0
  total++;
  if (bias(utcDaily, legIdx) !== bias(sessClose, engIdx)) divUtcVsSession++;
}
let fail = 0;
const div = 100 * divUtcVsSession / total;
console.log(`bars evaluated: ${total}`);
console.log(`legacy UTC-day vs engine session-close divergence: ${div.toFixed(2)}%  (expect 5-9% — the boundary bug being fixed)`);
console.log(`LEAK (engine aligns to a session closing AFTER the decision): ${leak}  (MUST be 0)`);
if (leak !== 0) { console.log("FAIL: leak detected"); fail++; }
if (div < 3 || div > 12) { console.log("FAIL: divergence outside expected band"); fail++; }
console.log(fail === 0 ? "\nSESSION-BOUNDARY VERIFIED (exact + leak-free)" : `\n${fail} FAILURE(S)`);
process.exit(fail === 0 ? 0 : 1);
