/**
 * Regime-library candidate validation — $0, zero LLM calls.
 *
 * Runs the four deterministic library candidates through 2020→present
 * walk-forward windows WITH their market_state_gate enforced (the same
 * gate live runs), plus an ungated control run per candidate so the
 * gate's contribution is measured rather than assumed
 * (feedback_instrument_alongside_validation).
 *
 * Candidates (evidence: market-state study n=696 + hold-side screen
 * n=2,041, 2026-06-11):
 *   dip_buyer      — bullish liquidity sweep + bullish D1 bias, long.
 *                    Gate: favourable-long mtf states + USD not falling.
 *   coil_breakout  — bullish BOS + bullish D1 bias, long.
 *                    Gate: compressed range only.
 *   range_fade     — bullish liquidity sweep, long.
 *                    Gate: all-TF ranging only.
 *   bear_short     — bearish BOS + bearish D1 bias, short.
 *                    Gate: aligned_LH only (the one state where shorts
 *                    out-earned longs in BOTH screens). Expected mostly
 *                    DORMANT in the 2024-2026 bull tape — its job is to
 *                    exist, gated off, until a bear regime returns.
 *
 * Shared geometry: comboC (swing_anchor 0.10/4 + rr3), risk_per_trade
 * 0.6%, max_positions 1 — identical to the live flagship's engine
 * config so candidate R is comparable.
 *
 * Ship gates (pre-registered, per candidate): ≥60% green windows among
 * windows with ≥1 trade, worst window DD ≤5%, AND gated beats ungated
 * on mean return (the gate must ADD value, not just exist).
 *
 * Usage:
 *   pnpm dlx tsx scripts/library-walk-forward.ts
 *   WINDOW_DAYS=40 STEP_DAYS=40 CAPITAL=100000
 *   ONLY=dip_buyer,bear_short   subset of candidates
 */
import { writeFileSync } from "fs";
import { runWalkForward } from "../src/lib/market-data/walk-forward";
import type { MarketStateSeries } from "../src/lib/market-data/portfolio-backtest";
import type { PriceBar } from "../src/lib/market-data/types";
import type { AlgorithmRules } from "../src/types/algorithm";
import { loadCorpus, type Corpus } from "./llm-trader-backtest";

const WINDOW_DAYS = Number(process.env.WINDOW_DAYS ?? 40);
const STEP_DAYS = Number(process.env.STEP_DAYS ?? 40);
const CAPITAL = Number(process.env.CAPITAL ?? 100_000);
const TICKER = "XAU/USD";

function baseRules(): AlgorithmRules {
  return {
    entry_conditions: [],
    exit_conditions: [],
    stop_loss: { type: "swing_anchor", value: 0.1, lookback: 4 },
    take_profit: { type: "rr_multiple", value: 3 },
    position_sizing: { type: "risk_per_trade", value: 0.6 },
    max_positions: 1,
    leverage: 9,
    timeframe: "4h",
    asset_class: "commodity",
    side: "long",
    stagnant_exit: { enabled: true },
  } as AlgorithmRules;
}

interface Candidate {
  key: string;
  rules: AlgorithmRules;
}

function buildCandidates(): Candidate[] {
  const dipBuyer = baseRules();
  dipBuyer.entry_conditions = [
    { type: "pattern", pattern: "liquidity_sweep", direction: "bullish", lookback: 5, timeframe: "4h" },
    { type: "pattern", pattern: "daily_bias", direction: "bullish", ma_period: 20, timeframe: "4h" },
  ];
  // Block-mode: exclude the two states both screens flag as negative
  // for longs (fast_div_bull −0.32R taken / +0.18R held; usd_down 0.24R
  // taken / 0.22R held — worst buckets) rather than allow-listing good
  // ones. With on_unreadable=allow the gate is inert before the 1h /
  // EUR-USD history floor (~Aug 2025) and binds live from then on —
  // allow-mode would fail closed for 5½ of the 6 validation years and
  // make the gate untestable.
  dipBuyer.market_state_gate = {
    mode: "block",
    states: { mtf: ["fast_div_bull"], dxy: ["usd_down"] },
    on_unreadable: "allow",
  };

  const coilBreakout = baseRules();
  coilBreakout.entry_conditions = [
    { type: "pattern", pattern: "bos", direction: "bullish", lookback: 5, timeframe: "4h" },
    { type: "pattern", pattern: "daily_bias", direction: "bullish", ma_period: 20, timeframe: "4h" },
  ];
  coilBreakout.market_state_gate = {
    mode: "allow",
    states: { range: ["compressed"] },
  };

  const rangeFade = baseRules();
  rangeFade.entry_conditions = [
    { type: "pattern", pattern: "liquidity_sweep", direction: "bullish", lookback: 5, timeframe: "4h" },
  ];
  rangeFade.market_state_gate = {
    mode: "allow",
    states: { mtf: ["ranging_all"] },
  };

  const bearShort = baseRules();
  bearShort.side = "short";
  bearShort.entry_conditions = [
    { type: "pattern", pattern: "bos", direction: "bearish", lookback: 5, timeframe: "4h" },
    { type: "pattern", pattern: "daily_bias", direction: "bearish", ma_period: 20, timeframe: "4h" },
  ];
  bearShort.market_state_gate = {
    mode: "allow",
    states: { mtf: ["aligned_LH"] },
  };

  return [
    { key: "dip_buyer", rules: dipBuyer },
    { key: "coil_breakout", rules: coilBreakout },
    { key: "range_fade", rules: rangeFade },
    { key: "bear_short", rules: bearShort },
  ];
}

function ungated(rules: AlgorithmRules): AlgorithmRules {
  const clone = JSON.parse(JSON.stringify(rules)) as AlgorithmRules;
  delete clone.market_state_gate;
  return clone;
}

interface RunReport {
  candidate: string;
  variant: "gated" | "ungated";
  windows: number;
  windows_with_trades: number;
  green_of_traded_pct: number;
  total_trades: number;
  total_return: number;
  mean_return: number;
  worst_dd: number;
  dd_breaches_gt5: number;
}

function reportFor(
  candidate: string,
  variant: "gated" | "ungated",
  summary: ReturnType<typeof runWalkForward>
): RunReport {
  const traded = summary.windows.filter((w) => w.total_trades > 0);
  const green = traded.filter((w) => w.total_return > 0);
  return {
    candidate,
    variant,
    windows: summary.total_windows,
    windows_with_trades: traded.length,
    green_of_traded_pct: traded.length ? (green.length / traded.length) * 100 : 0,
    total_trades: summary.windows.reduce((s, w) => s + w.total_trades, 0),
    total_return: Number(summary.windows.reduce((s, w) => s + w.total_return, 0).toFixed(0)),
    mean_return: Number(summary.mean_return.toFixed(0)),
    worst_dd: Number(Math.max(0, ...summary.windows.map((w) => w.max_drawdown)).toFixed(2)),
    dd_breaches_gt5: summary.windows.filter((w) => w.max_drawdown > 5).length,
  };
}

async function main(): Promise<void> {
  const only = process.env.ONLY?.split(",").map((s) => s.trim());
  const candidates = buildCandidates().filter((c) => !only || only.includes(c.key));

  console.log(`Loading full-depth corpus for ${TICKER}...`);
  const corpus: Corpus = await loadCorpus("4h");
  const corpus1h: Corpus = await loadCorpus("1h");
  const bars: PriceBar[] = corpus.bars;
  console.log(
    `  4h: ${bars.length} bars (${bars[0]?.date.slice(0, 10)} → ${bars[bars.length - 1]?.date.slice(0, 10)}) · 1h: ${corpus1h.bars.length} · daily: ${corpus.dailyBars.length} · eurusd4h: ${corpus.eurusd4h.length}`
  );
  console.log(
    `  NOTE: mtf/dxy features need 1h + EUR/USD history (≈ ${corpus1h.bars[0]?.date.slice(0, 10) ?? "?"} onward); vol needs ~1y of 4h warm-up.`
  );
  console.log(
    `  Gated candidates fail closed before their features are readable — early windows under-trade BY DESIGN.\n`
  );

  const marketStateSeries: MarketStateSeries = {
    bars4h: new Map([[TICKER, bars]]),
    oneHour: new Map([[TICKER, corpus1h.bars]]),
    daily: new Map([[TICKER, corpus.dailyBars]]),
    eurusd4h: corpus.eurusd4h,
  };
  const prices = new Map([[TICKER, bars]]);

  const reports: RunReport[] = [];
  for (const c of candidates) {
    for (const variant of ["gated", "ungated"] as const) {
      const rules = variant === "gated" ? c.rules : ungated(c.rules);
      const summary = runWalkForward(rules, prices, CAPITAL, {
        testWindowDays: WINDOW_DAYS,
        stepDays: STEP_DAYS,
        marketStateSeries: variant === "gated" ? marketStateSeries : null,
      });
      const rep = reportFor(c.key, variant, summary);
      reports.push(rep);
      console.log(
        `${c.key.padEnd(14)} ${variant.padEnd(8)} windows=${rep.windows} traded=${rep.windows_with_trades} green(traded)=${rep.green_of_traded_pct.toFixed(0)}% trades=${rep.total_trades} totalRet=$${rep.total_return} meanRet=$${rep.mean_return} worstDD=${rep.worst_dd}% ddBreaches>5%=${rep.dd_breaches_gt5}`
      );
    }
  }

  console.log("\n--- Ship-gate verdicts (pre-registered) ---");
  for (const c of candidates) {
    const g = reports.find((r) => r.candidate === c.key && r.variant === "gated")!;
    const u = reports.find((r) => r.candidate === c.key && r.variant === "ungated")!;
    const checks = [
      { name: "green(traded) ≥60%", pass: g.green_of_traded_pct >= 60 },
      { name: "worst DD ≤5%", pass: g.worst_dd <= 5 },
      { name: "gate adds value (gated mean ≥ ungated mean)", pass: g.mean_return >= u.mean_return },
      { name: "has trades at all", pass: g.total_trades > 0 },
    ];
    const verdict = checks.every((x) => x.pass) ? "SHIP (paper)" : "HOLD";
    console.log(
      `${c.key.padEnd(14)} ${verdict}  [${checks.map((x) => `${x.name}: ${x.pass ? "✓" : "✗"}`).join(" · ")}]`
    );
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outPath = `scripts/library-walk-forward-${stamp}.json`;
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        window_days: WINDOW_DAYS,
        step_days: STEP_DAYS,
        capital: CAPITAL,
        candidates: candidates.map((c) => ({ key: c.key, rules: c.rules })),
        reports,
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
