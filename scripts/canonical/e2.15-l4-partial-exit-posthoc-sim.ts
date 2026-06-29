/**
 * E2.15 L4 — Partial-exit POST-HOC empirical test.
 *
 * Hypothesis: closing 50% of position at +1R + holding remainder with
 * SL trailed to break-even improves return-per-DD vs holding-to-original-
 * exit. Literature: +20-50% Sharpe expected.
 *
 * Method (no engine change required):
 *   1. Run deployed algo backtest → trade list
 *   2. For each trade, recompute SL distance via computeSlDistance
 *      (matches engine logic exactly)
 *   3. Walk intra-trade bars: did intra-bar HIGH (long) / LOW (short)
 *      reach the +1R level?
 *   4. If yes: split trade into [50% at +1R, 50% with new SL at entry (BE)]
 *      Walk remainder from partial-bar to original-exit-bar:
 *        - If BE hit (low ≤ entry for long) → remainder = 0R
 *        - Else if 3R TP hit → remainder = +3R (×0.5)
 *        - Else (held to original exit) → remainder = original R × 0.5
 *   5. If no: trade unchanged
 *   6. Aggregate new pnl distribution; compare Sharpe + DD vs baseline
 *
 * Gate (pre-registered): partial-exit must improve Sharpe ≥+10% AND
 * NOT increase max-loss-from-initial (FTMO Max Loss metric) ≥+15%.
 *
 * Honoring [[feedback_ftmo_max_loss_is_fixed_floor]]: DD = max loss
 * from initial balance, NOT peak-to-trough.
 *
 * If gate PASSES → file engine-integration follow-up.
 * If gate FAILS → empirically rule out partial-exit; save 1-2 days build.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { computeSlDistance } from "../../src/lib/algorithm/structural-sl";
import { timeframeToInterval } from "../../src/lib/market-data/interval";
import { runPortfolioBacktest } from "../../src/lib/market-data/portfolio-backtest";
import type { Database } from "../../src/lib/supabase/database.types";
import type { BacktestTrade, PriceBar } from "../../src/lib/market-data/types";
import type { AlgorithmRules } from "../../src/types/algorithm";

function loadEnvLocal(): void {
  try {
    const envText = readFileSync(resolve(process.cwd(), ".env.local"), "utf-8");
    for (const line of envText.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      if (!(key in process.env)) process.env[key] = val;
    }
  } catch {}
}
loadEnvLocal();

const DEPLOY_ID = "1ebdce3d-4ab9-4e30-b5d3-075942b7cf69";
const INITIAL_CAPITAL = 10000;
const PARTIAL_AT_R = Number(process.env.PARTIAL_AT_R ?? "1.0");
const PARTIAL_FRACTION = Number(process.env.PARTIAL_FRACTION ?? "0.5");
const TP_RR = 3.0;

interface PartialOutcome {
  trade: BacktestTrade;
  fired: boolean;
  partial_r: number;
  remainder_r: number;
  total_r: number;
  partial_pnl: number;
  remainder_pnl: number;
  total_pnl: number;
}

function dateToMs(s: string): number {
  return Date.parse(s);
}

function findBarIndex(bars: PriceBar[], date: string): number {
  const target = dateToMs(date);
  // Linear scan with early-exit; bars are sorted ASC
  for (let i = 0; i < bars.length; i++) {
    if (dateToMs(bars[i].date) === target) return i;
  }
  return -1;
}

function findBarIndexAtOrBefore(bars: PriceBar[], date: string): number {
  const target = dateToMs(date);
  let lo = 0, hi = bars.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const bd = dateToMs(bars[mid].date);
    if (bd <= target) { best = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  return best;
}

function simulatePartial(
  trade: BacktestTrade,
  bars: PriceBar[],
  rules: AlgorithmRules,
  capital: number,
  symbol: string,
): PartialOutcome {
  const entryIdx = findBarIndex(bars, trade.entry_date);
  const exitIdx = findBarIndex(bars, trade.exit_date);
  if (entryIdx < 0 || exitIdx < 0 || exitIdx < entryIdx) {
    // Can't simulate — return original
    const origR = trade.pnl / (capital * (rules.position_sizing.value / 100));
    return {
      trade,
      fired: false,
      partial_r: 0,
      remainder_r: 0,
      total_r: origR,
      partial_pnl: 0,
      remainder_pnl: trade.pnl,
      total_pnl: trade.pnl,
    };
  }
  const slDistance = computeSlDistance(rules.stop_loss, trade.side, trade.entry_price, symbol, bars, entryIdx);
  if (slDistance <= 0) {
    // SL distance non-positive — engine wouldn't have entered; defensive
    return {
      trade, fired: false, partial_r: 0, remainder_r: 0,
      total_r: 0, partial_pnl: 0, remainder_pnl: trade.pnl, total_pnl: trade.pnl,
    };
  }
  const oneRLevel = trade.side === "long" ? trade.entry_price + slDistance : trade.entry_price - slDistance;
  const tpLevel = trade.side === "long" ? trade.entry_price + TP_RR * slDistance : trade.entry_price - TP_RR * slDistance;
  const riskDollars = capital * (rules.position_sizing.value / 100);

  // Walk bars from entryIdx+1 to exitIdx (inclusive) checking for +1R hit
  // Note: entry bar itself is the entry candle; intra-bar movement after entry is the next bars
  let partialBarIdx = -1;
  for (let i = entryIdx + 1; i <= exitIdx; i++) {
    const b = bars[i];
    const reached = trade.side === "long" ? b.high >= oneRLevel : b.low <= oneRLevel;
    if (reached) { partialBarIdx = i; break; }
  }

  if (partialBarIdx === -1) {
    // 1R never hit → trade unchanged
    const origR = trade.pnl / riskDollars;
    return {
      trade, fired: false, partial_r: 0, remainder_r: origR,
      total_r: origR, partial_pnl: 0, remainder_pnl: trade.pnl, total_pnl: trade.pnl,
    };
  }

  // Partial fired
  const partialR = PARTIAL_FRACTION * PARTIAL_AT_R;
  const partialPnl = partialR * riskDollars;

  // Remainder: from partialBarIdx onward, new SL at entry (BE)
  // Check: did BE hit OR TP hit OR original exit
  let remainderR: number;
  let remainderExitReason: "BE" | "TP" | "ORIGINAL";
  let remainderExitBarIdx = exitIdx;
  for (let i = partialBarIdx; i <= exitIdx; i++) {
    const b = bars[i];
    // Check BE first (more conservative — assumes BE could fire same bar as TP)
    const beHit = trade.side === "long" ? b.low <= trade.entry_price : b.high >= trade.entry_price;
    const tpHit = trade.side === "long" ? b.high >= tpLevel : b.low <= tpLevel;
    if (beHit && tpHit) {
      // Same bar — ambiguous. Conservatively assume BE first (worse outcome).
      remainderR = 0;
      remainderExitReason = "BE";
      remainderExitBarIdx = i;
      break;
    }
    if (beHit) {
      remainderR = 0;
      remainderExitReason = "BE";
      remainderExitBarIdx = i;
      break;
    }
    if (tpHit) {
      remainderR = PARTIAL_FRACTION * TP_RR;
      remainderExitReason = "TP";
      remainderExitBarIdx = i;
      break;
    }
  }
  // Loop completed without break → remainder held to original exit
  // Compute remainder pnl at original exit price (×0.5 fraction)
  if (typeof remainderR! === "undefined") {
    const origR = (trade.exit_price - trade.entry_price) / slDistance * (trade.side === "long" ? 1 : -1);
    remainderR = PARTIAL_FRACTION * origR;
    remainderExitReason = "ORIGINAL";
  }
  const remainderPnl = remainderR! * riskDollars;
  return {
    trade,
    fired: true,
    partial_r: partialR,
    remainder_r: remainderR!,
    total_r: partialR + remainderR!,
    partial_pnl: partialPnl,
    remainder_pnl: remainderPnl,
    total_pnl: partialPnl + remainderPnl,
  };
}

function computeSharpe(pnls: readonly number[], riskDollars: number): number {
  if (pnls.length < 2 || riskDollars <= 0) return 0;
  const r = pnls.map((p) => p / riskDollars);
  const m = r.reduce((a, b) => a + b, 0) / r.length;
  let v = 0; for (const x of r) v += (x - m) ** 2;
  const sd = Math.sqrt(v / r.length);
  return sd === 0 ? 0 : m / sd;
}

function ftmoMaxLossPct(trades: ReadonlyArray<{ exit_date: string; pnl: number }>, initialCapital: number): number {
  if (trades.length === 0 || initialCapital <= 0) return 0;
  const sorted = [...trades].sort((a, b) => a.exit_date.localeCompare(b.exit_date));
  let equity = initialCapital, minEquity = initialCapital;
  for (const t of sorted) {
    equity += t.pnl;
    if (equity < minEquity) minEquity = equity;
  }
  return Math.max(0, ((initialCapital - minEquity) / initialCapital) * 100);
}

function peakToTroughPct(trades: ReadonlyArray<{ exit_date: string; pnl: number }>, initialCapital: number): number {
  if (trades.length === 0 || initialCapital <= 0) return 0;
  const sorted = [...trades].sort((a, b) => a.exit_date.localeCompare(b.exit_date));
  let eq = initialCapital, peak = initialCapital, maxDd = 0;
  for (const t of sorted) {
    eq += t.pnl;
    if (eq > peak) peak = eq;
    if (peak - eq > maxDd) maxDd = peak - eq;
  }
  return (maxDd / initialCapital) * 100;
}

async function main(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const sb = createClient<Database>(url, key);

  const { data: dep } = await sb.from("algorithms").select("name, rules").eq("id", DEPLOY_ID).maybeSingle();
  if (!dep) throw new Error("deployed algo not found");
  const rules = dep.rules as unknown as AlgorithmRules;

  const interval = timeframeToInterval("4h");
  const { data: bd } = await sb.from("price_cache").select("bars")
    .eq("ticker", "XAU/USD").eq("output_size", "full").eq("interval", interval).limit(1).single();
  const bars = bd!.bars as unknown as PriceBar[];

  console.log(`E2.15 L4 — Partial-exit post-hoc empirical test`);
  console.log(`Deployed algo: ${dep.name}`);
  console.log(`SL: ${rules.stop_loss.type} (lookback=${rules.stop_loss.lookback}, value=${rules.stop_loss.value})`);
  console.log(`TP: ${rules.take_profit.type} value=${rules.take_profit.value}`);
  console.log(`Risk: ${rules.position_sizing.value}%`);
  console.log(`Partial config: ${PARTIAL_FRACTION * 100}% at +${PARTIAL_AT_R}R, runner with BE-trailed SL, TP at +${TP_RR}R`);
  console.log("");

  const result = runPortfolioBacktest(rules, new Map([["XAU/USD", bars]]), INITIAL_CAPITAL);
  const trades = result.trades ?? [];
  const riskDollars = INITIAL_CAPITAL * (rules.position_sizing.value / 100);

  const outcomes = trades.map((t) => simulatePartial(t, bars, rules, INITIAL_CAPITAL, "XAU/USD"));
  const fired = outcomes.filter((o) => o.fired).length;

  const baselinePnls = trades.map((t) => t.pnl);
  const partialPnls = outcomes.map((o) => o.total_pnl);
  const baselineTotalPnl = baselinePnls.reduce((a, b) => a + b, 0);
  const partialTotalPnl = partialPnls.reduce((a, b) => a + b, 0);
  const baselineSharpe = computeSharpe(baselinePnls, riskDollars);
  const partialSharpe = computeSharpe(partialPnls, riskDollars);
  const baselineFtmoDd = ftmoMaxLossPct(trades.map((t) => ({ exit_date: t.exit_date, pnl: t.pnl })), INITIAL_CAPITAL);
  const partialFtmoDd = ftmoMaxLossPct(outcomes.map((o) => ({ exit_date: o.trade.exit_date, pnl: o.total_pnl })), INITIAL_CAPITAL);
  const baselinePtt = peakToTroughPct(trades.map((t) => ({ exit_date: t.exit_date, pnl: t.pnl })), INITIAL_CAPITAL);
  const partialPtt = peakToTroughPct(outcomes.map((o) => ({ exit_date: o.trade.exit_date, pnl: o.total_pnl })), INITIAL_CAPITAL);

  const baselineWins = trades.filter((t) => t.pnl > 0).length;
  const partialWins = outcomes.filter((o) => o.total_pnl > 0).length;

  const first = trades[0]?.exit_date.slice(0, 10) ?? "";
  const last = trades[trades.length - 1]?.exit_date.slice(0, 10) ?? "";
  const years = (Date.parse(last) - Date.parse(first)) / (365.25 * 24 * 3600 * 1000);

  console.log(`Total trades: ${trades.length}`);
  console.log(`Partials fired: ${fired} / ${trades.length} (${((fired/trades.length)*100).toFixed(1)}%)`);
  console.log("");
  console.log(`Metric                 | BASELINE          | PARTIAL-EXIT        | Δ`);
  console.log(`-`.repeat(85));
  console.log(`Total PnL              | $${baselineTotalPnl.toFixed(0).padStart(7)}          | $${partialTotalPnl.toFixed(0).padStart(7)}            | ${((partialTotalPnl - baselineTotalPnl)/Math.abs(baselineTotalPnl)*100).toFixed(1)}%`);
  console.log(`Annual return          | ${(baselineTotalPnl/INITIAL_CAPITAL*100/years).toFixed(2).padStart(6)}%           | ${(partialTotalPnl/INITIAL_CAPITAL*100/years).toFixed(2).padStart(6)}%             | -`);
  console.log(`Monthly return         | ${(baselineTotalPnl/INITIAL_CAPITAL*100/years/12).toFixed(3).padStart(6)}%           | ${(partialTotalPnl/INITIAL_CAPITAL*100/years/12).toFixed(3).padStart(6)}%             | -`);
  console.log(`Sharpe (per-trade)     | ${baselineSharpe.toFixed(4).padStart(7)}           | ${partialSharpe.toFixed(4).padStart(7)}             | ${((partialSharpe - baselineSharpe)/baselineSharpe*100).toFixed(1)}%`);
  console.log(`Win rate               | ${((baselineWins/trades.length)*100).toFixed(1)}%             | ${((partialWins/outcomes.length)*100).toFixed(1)}%               | -`);
  console.log(`FTMO Max Loss          | ${baselineFtmoDd.toFixed(2).padStart(6)}%           | ${partialFtmoDd.toFixed(2).padStart(6)}%             | ${(partialFtmoDd - baselineFtmoDd).toFixed(2)}pp`);
  console.log(`Peak-to-trough (info)  | ${baselinePtt.toFixed(2).padStart(6)}%           | ${partialPtt.toFixed(2).padStart(6)}%             | ${(partialPtt - baselinePtt).toFixed(2)}pp`);
  console.log("");

  const sharpeLift = ((partialSharpe - baselineSharpe) / baselineSharpe) * 100;
  const ddDelta = partialPtt - baselinePtt;
  const ftmoDelta = partialFtmoDd - baselineFtmoDd;
  console.log(`Gate (locked pre-test): Sharpe lift ≥+10% AND FTMO Max Loss delta ≤+15%`);
  const passes = sharpeLift >= 10 && Math.abs(ftmoDelta) <= 15;
  console.log(`  Sharpe lift           : ${sharpeLift.toFixed(1)}% ${sharpeLift >= 10 ? "✓" : "✗"}`);
  console.log(`  FTMO Max Loss delta   : ${ftmoDelta.toFixed(2)}pp ${Math.abs(ftmoDelta) <= 15 ? "✓" : "✗"}`);
  console.log(`  VERDICT: ${passes ? "✓ PASS — justifies engine integration" : "✗ FAIL — partial-exit NOT a winning lever for this algo"}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
