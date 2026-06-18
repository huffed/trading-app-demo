/**
 * Multi-window validation of new gold strategy candidates.
 *
 * Tests each candidate against THREE windows:
 *   1. Full corpus walk-forward (≥70% green, mean DD ≤8%, worst DD ≤10%)
 *   2. Last 6 months single backtest (positive return, DD ≤10%)
 *   3. Last 60 days single backtest (positive return, DD ≤8%)
 *
 * Strategy must pass ALL three. Today's failure was deploying winners
 * that only passed (1).
 *
 * Strategy candidates: long + short × 4 templates (ICT BOS+OB, ICT sweep+FVG,
 * 4h trend pullback, daily SMA200).
 *
 * Uses cached XAU/USD data (no API quota needed). Resamples 1h Yahoo
 * bars to 4h when the strategy's primary TF is 4h.
 *
 * Usage:
 *   pnpm dlx tsx scripts/rebuild-gold-stack.ts
 */
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import { runWalkForward } from "../src/lib/market-data/walk-forward";
import { runPortfolioBacktest } from "../src/lib/market-data/portfolio-backtest";
import { fetchDailyPrices } from "../src/lib/market-data/prices";
import { resampleTo } from "../src/lib/market-data/resample";
import {
  defaultWalkForwardStepDays,
  defaultWalkForwardWindowDays,
} from "../src/lib/market-data/interval";
import type { PriceBar } from "../src/lib/market-data/types";
import type { AlgorithmRules } from "../src/types/algorithm";

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

interface Candidate {
  name: string;
  side: "long" | "short";
  timeframe: string;
  rules: AlgorithmRules;
}

interface WindowResult {
  trades: number;
  wr: number;
  ret: number;
  dd: number;
  green_pct?: number;
  mean_dd?: number;
  worst_dd?: number;
  total_windows?: number;
}

interface ValidationResult {
  candidate: Candidate;
  full_wf: WindowResult;
  recent_6mo: WindowResult;
  recent_60d: WindowResult;
  pass: boolean;
  fail_reasons: string[];
}

const CAPITAL = 100_000;

function buildBaseRules(side: "long" | "short", timeframe: string): AlgorithmRules {
  return {
    asset_class: "commodity",
    side,
    timeframe,
    leverage: 50,
    position_sizing: { type: "risk_per_trade", value: 1 },
    stop_loss: { type: "swing_anchor", value: 0.25, lookback: 12, atr_period: 14 },
    take_profit: { type: "rr_multiple", value: 4 },
    max_positions: 1,
    max_per_ticker: 1,
    entry_conditions: [],
    exit_conditions: [],
    entry_logic: "all",
    regime_filter: { enabled: true, atr_period: 20, lookback_days: 90, percentile_floor: 0.3 },
    adx_filter: { enabled: true, min_adx: 20, adx_period: 14 },
    stagnant_exit: { enabled: true, max_bars: 48, min_pnl_r: -0.5, min_excursion_r: 0.1 },
    prop_firm: {
      max_drawdown: 10,
      profit_target: 10,
      daily_loss_limit: 5,
      consistency_rule: 40,
      consecutive_loss_daily_halt: 3,
      consecutive_loss_unit: "days",
      max_consecutive_losses: 0,
      slippage_bps: 10,
      spread_bps: 5,
      commission_pct: 0,
    },
  };
}

function buildCandidates(): Candidate[] {
  const list: Candidate[] = [];

  // 4h ICT BOS+OB (long & short)
  for (const side of ["long", "short"] as const) {
    const dir = side === "long" ? "bullish" : "bearish";
    list.push({
      name: `4h_ict_bos_ob_${side}`,
      side,
      timeframe: "4h",
      rules: {
        ...buildBaseRules(side, "4h"),
        entry_conditions: [
          { type: "pattern", pattern: "daily_bias", direction: dir, ma_period: 20, timeframe: "1d" },
          { type: "pattern", pattern: "bos", direction: dir, lookback: 5, timeframe: "4h" },
          { type: "pattern", pattern: "order_block", direction: dir, timeframe: "4h" },
        ],
        entry_logic: { type: "n_of_m", n: 2 },
      },
    });
  }

  // 4h ICT sweep+FVG (long & short)
  for (const side of ["long", "short"] as const) {
    const dir = side === "long" ? "bullish" : "bearish";
    list.push({
      name: `4h_ict_sweep_fvg_${side}`,
      side,
      timeframe: "4h",
      rules: {
        ...buildBaseRules(side, "4h"),
        entry_conditions: [
          { type: "pattern", pattern: "daily_bias", direction: dir, ma_period: 20, timeframe: "1d" },
          { type: "pattern", pattern: "liquidity_sweep", direction: dir, lookback: 5, timeframe: "4h" },
          { type: "pattern", pattern: "fvg", direction: dir, timeframe: "4h" },
        ],
        entry_logic: { type: "n_of_m", n: 2 },
      },
    });
  }

  // 4h trend-pullback (existing template, long + new short mirror)
  for (const side of ["long", "short"] as const) {
    const dir = side === "long" ? "bullish" : "bearish";
    const rsiOp = side === "long" ? "greater_than" : "less_than";
    const rsiVal = side === "long" ? 40 : 60;
    list.push({
      name: `4h_trend_pullback_${side}`,
      side,
      timeframe: "4h",
      rules: {
        ...buildBaseRules(side, "4h"),
        entry_conditions: [
          { type: "pattern", pattern: "daily_bias", direction: dir, ma_period: 20, timeframe: "1d" },
          { type: "pattern", pattern: "pin_bar", direction: dir, timeframe: "4h" },
          { type: "technical", indicator: "RSI", operator: rsiOp, value: rsiVal, timeframe: "4h" },
        ],
        entry_logic: { type: "n_of_m", n: 2 },
      },
    });
  }

  // Daily SMA200 trend filter (long + short)
  for (const side of ["long", "short"] as const) {
    const op = side === "long" ? "crosses_above" : "crosses_below";
    list.push({
      name: `1d_sma200_${side}`,
      side,
      timeframe: "1d",
      rules: {
        ...buildBaseRules(side, "1d"),
        entry_conditions: [
          { type: "technical", indicator: "SMA200", operator: op, value: 0, timeframe: "1d" },
        ],
        entry_logic: "all",
        // Daily TF — looser stagnant cap; trades held days/weeks.
        stagnant_exit: { enabled: true, max_bars: 30, min_pnl_r: -0.5, min_excursion_r: 0.1 },
      },
    });
  }

  return list;
}

function sliceBarsByDays(bars: PriceBar[], days: number): PriceBar[] {
  const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
  return bars.filter((b) => new Date(b.date).getTime() >= cutoffMs);
}

async function loadCorpus(timeframe: string): Promise<Map<string, PriceBar[]>> {
  // For 4h: load 1h cache, resample to 4h. For 1d: use 1d cache directly.
  if (timeframe === "1d") {
    const bars = await fetchDailyPrices("XAU/USD", "full", "1day");
    return new Map([["XAU/USD", bars]]);
  }
  if (timeframe === "4h") {
    const hourly = await fetchDailyPrices("XAU/USD", "full", "1h");
    const bars4h = resampleTo(hourly, "4h");
    return new Map([["XAU/USD", bars4h]]);
  }
  throw new Error(`Unsupported timeframe ${timeframe}`);
}

async function loadProxy(): Promise<PriceBar[]> {
  // EUR/USD 4h proxy is cached from earlier work — best for daily/4h DXY context.
  return await fetchDailyPrices("EUR/USD", "full", "4h");
}

function summariseSingleBacktest(rules: AlgorithmRules, prices: Map<string, PriceBar[]>, proxy: PriceBar[]): WindowResult {
  const r = runPortfolioBacktest(rules, prices, CAPITAL, [], proxy);
  return {
    trades: r.total_trades,
    wr: r.win_rate,
    ret: r.total_return,
    dd: r.max_drawdown,
  };
}

function summariseWalkForward(rules: AlgorithmRules, prices: Map<string, PriceBar[]>, tf: string): WindowResult {
  const wfWindowDays = defaultWalkForwardWindowDays(tf);
  const wfStepDays = defaultWalkForwardStepDays(tf);
  const wf = runWalkForward(rules, prices, CAPITAL, {
    testWindowDays: wfWindowDays,
    stepDays: wfStepDays,
  });
  const totalTrades = wf.windows.reduce((s, w) => s + w.total_trades, 0);
  const meanWr =
    wf.windows.reduce((s, w) => s + w.win_rate, 0) / Math.max(wf.windows.length, 1);
  const worstDd = wf.windows.reduce((max, w) => Math.max(max, w.max_drawdown), 0);
  return {
    trades: totalTrades,
    wr: meanWr,
    ret: wf.mean_return,
    dd: wf.mean_drawdown,
    green_pct: wf.win_rate_of_windows * 100,
    mean_dd: wf.mean_drawdown,
    worst_dd: worstDd,
    total_windows: wf.total_windows,
  };
}

async function validateCandidate(c: Candidate): Promise<ValidationResult> {
  const fullPrices = await loadCorpus(c.timeframe);
  const proxy = await loadProxy();

  const fullBars = fullPrices.get("XAU/USD")!;
  const sliced6mo = sliceBarsByDays(fullBars, 180);
  const sliced60d = sliceBarsByDays(fullBars, 60);
  const proxy6mo = sliceBarsByDays(proxy, 180);
  const proxy60d = sliceBarsByDays(proxy, 60);

  const full_wf = summariseWalkForward(c.rules, fullPrices, c.timeframe);
  const recent_6mo = summariseSingleBacktest(
    c.rules,
    new Map([["XAU/USD", sliced6mo]]),
    proxy6mo
  );
  const recent_60d = summariseSingleBacktest(
    c.rules,
    new Map([["XAU/USD", sliced60d]]),
    proxy60d
  );

  const fail_reasons: string[] = [];
  const PASS_GREEN_PCT = 70;
  const PASS_MEAN_DD = 8;
  const PASS_WORST_DD = 10;

  if ((full_wf.green_pct ?? 0) < PASS_GREEN_PCT)
    fail_reasons.push(`full WF green ${(full_wf.green_pct ?? 0).toFixed(0)}% < ${PASS_GREEN_PCT}%`);
  if ((full_wf.mean_dd ?? 0) > PASS_MEAN_DD)
    fail_reasons.push(`full WF meanDD ${(full_wf.mean_dd ?? 0).toFixed(2)}% > ${PASS_MEAN_DD}%`);
  if ((full_wf.worst_dd ?? 0) > PASS_WORST_DD)
    fail_reasons.push(`full WF worstDD ${(full_wf.worst_dd ?? 0).toFixed(2)}% > ${PASS_WORST_DD}%`);
  if (full_wf.ret <= 0) fail_reasons.push(`full WF mean return ${full_wf.ret.toFixed(0)} <= 0`);
  if (recent_6mo.ret <= 0) fail_reasons.push(`6mo return ${recent_6mo.ret.toFixed(0)} <= 0`);
  if (recent_6mo.dd > 10) fail_reasons.push(`6mo DD ${recent_6mo.dd.toFixed(2)}% > 10%`);
  if (recent_60d.ret <= 0) fail_reasons.push(`60d return ${recent_60d.ret.toFixed(0)} <= 0`);
  if (recent_60d.dd > 8) fail_reasons.push(`60d DD ${recent_60d.dd.toFixed(2)}% > 8%`);
  // Sample-size sanity
  if (recent_60d.trades === 0) fail_reasons.push("60d zero trades (signal not firing)");

  return {
    candidate: c,
    full_wf,
    recent_6mo,
    recent_60d,
    pass: fail_reasons.length === 0,
    fail_reasons,
  };
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

async function main(): Promise<void> {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
  // Smoke test: confirm Supabase reachable.
  await supabase.from("algorithms").select("id").limit(1);

  const candidates = buildCandidates();
  console.log(`Validating ${candidates.length} strategy candidates against 3 windows each.`);
  console.log("Pass criteria: full WF ≥70% green / meanDD ≤8% / worstDD ≤10% / +ret · 6mo +ret/DD ≤10% · 60d +ret/DD ≤8%/non-zero trades.");
  console.log("");

  const results: ValidationResult[] = [];
  for (const c of candidates) {
    process.stdout.write(`  ${c.name} ... `);
    try {
      const r = await validateCandidate(c);
      results.push(r);
      console.log(r.pass ? "PASS" : `fail (${r.fail_reasons.length} reason${r.fail_reasons.length === 1 ? "" : "s"})`);
    } catch (err) {
      console.log(`ERROR: ${err instanceof Error ? err.message : err}`);
    }
  }
  console.log("");

  console.log(
    pad("candidate", 28) +
      pad("WF gn%", 8) +
      pad("WF$", 9) +
      pad("WFworstDD", 11) +
      pad("6mo$", 9) +
      pad("6moDD", 8) +
      pad("60d t", 7) +
      pad("60d$", 9) +
      pad("60dDD", 8) +
      "verdict"
  );
  console.log("-".repeat(110));
  for (const r of results) {
    console.log(
      pad(r.candidate.name, 28) +
        pad((r.full_wf.green_pct ?? 0).toFixed(0) + "%", 8) +
        pad(`$${r.full_wf.ret.toFixed(0)}`, 9) +
        pad((r.full_wf.worst_dd ?? 0).toFixed(2) + "%", 11) +
        pad(`$${r.recent_6mo.ret.toFixed(0)}`, 9) +
        pad(r.recent_6mo.dd.toFixed(2) + "%", 8) +
        pad(String(r.recent_60d.trades), 7) +
        pad(`$${r.recent_60d.ret.toFixed(0)}`, 9) +
        pad(r.recent_60d.dd.toFixed(2) + "%", 8) +
        (r.pass ? "PASS" : "fail")
    );
  }
  console.log("");

  const passing = results.filter((r) => r.pass);
  console.log(`${passing.length} of ${results.length} candidates pass all 3 windows.`);
  if (passing.length === 0) {
    console.log("");
    console.log("No survivors. Top 3 by 60d return for diagnostic follow-up:");
    const top = [...results].sort((a, b) => b.recent_60d.ret - a.recent_60d.ret).slice(0, 3);
    for (const r of top) {
      console.log(
        `  ${r.candidate.name}: 60d ${r.recent_60d.trades}t / WR ${r.recent_60d.wr.toFixed(1)}% / $${r.recent_60d.ret.toFixed(0)} / DD ${r.recent_60d.dd.toFixed(2)}%`
      );
      console.log(`    fails: ${r.fail_reasons.join("; ")}`);
    }
  } else {
    for (const r of passing) {
      console.log(
        `  ✓ ${r.candidate.name} — WF $${r.full_wf.ret.toFixed(0)}/${(r.full_wf.green_pct ?? 0).toFixed(0)}% · 6mo $${r.recent_6mo.ret.toFixed(0)}/${r.recent_6mo.dd.toFixed(2)}%DD · 60d $${r.recent_60d.ret.toFixed(0)}/${r.recent_60d.trades}t`
      );
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
