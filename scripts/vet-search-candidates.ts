/**
 * Batch-vets the top N candidates from the combinatorial search by
 * running a fresh full-corpus backtest on each, side-by-side with the
 * search's walk-forward summary. Surfaces candidates whose search rank
 * doesn't survive long-corpus validation (Candidate A's pattern: 86%
 * green walk-forward windows but negative aggregate EV on 173 days).
 *
 * Output is a comparison table with PASS/FAIL verdict per candidate.
 *
 * Pass criteria (Phase 1 of `docs/gold-trader-grade-roadmap.md`):
 *   - fresh trade count ≥ 5
 *   - fresh win rate ≥ 35%
 *   - fresh total return > 0
 *   - fresh max drawdown < 15%
 *
 * Run:
 *   pnpm tsx scripts/vet-search-candidates.ts
 *
 * Env defaults: CAPITAL=100000, TARGET=10, SYMBOLS=XAU/USD, TOP_N=10,
 * MAX_CANDIDATES=80.
 */
import { readFileSync } from "fs";
import {
  runCombinatorialSearch,
  type CandidateResult,
} from "../src/lib/algorithm/combinatorial-search";
import { timeframeToInterval, type BarInterval } from "../src/lib/market-data/interval";
import { runPortfolioBacktest } from "../src/lib/market-data/portfolio-backtest";
import { fetchDailyPrices } from "../src/lib/market-data/prices";
import type { BacktestTrade, PriceBar } from "../src/lib/market-data/types";
import type { AlgorithmRules, EntryCondition } from "../src/types/algorithm";

// Manual env loader.
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

const PASS_MIN_TRADES = 5;
const PASS_MIN_WR_PCT = 35;
const PASS_MAX_DD_PCT = 15;

/**
 * Build exit_conditions for a given template based on its signal class.
 * The pattern is "exit on signal invalidation" — if the entry condition's
 * directional thesis is broken, close the position. Designed by template
 * family; defaults to no exit conditions (relies on SL/TP/stagnant).
 *
 * For LONG entries: bearish version of the entry pattern fires the exit.
 * For SHORT fades: extreme overshoot of the entry signal fires the exit.
 * For AUTO-side templates: skip — needs per-side handling we don't have yet.
 */
function defaultExitConditionsFor(
  templateName: string,
  primaryTf: string,
  side: string
): { exit_conditions: EntryCondition[]; exit_logic: AlgorithmRules["exit_logic"] } {
  const none = { exit_conditions: [], exit_logic: undefined as AlgorithmRules["exit_logic"] };
  if (side === "auto") return none;

  // Momentum family — exit on opposite momentum confirmation
  if (templateName === "momentum_solo" || templateName === "momentum_with_bias") {
    return {
      exit_conditions: [
        {
          type: "pattern",
          pattern: "momentum",
          direction: "bearish",
          lookback: 3,
          timeframe: primaryTf,
        },
      ],
      exit_logic: "any",
    };
  }

  // Multi-TF engulfing+BOS family — exit on bearish 4h engulfing
  if (templateName.startsWith("multi_tf_engulf_bos")) {
    return {
      exit_conditions: [
        { type: "pattern", pattern: "engulfing", direction: "bearish", timeframe: "4h" },
      ],
      exit_logic: "any",
    };
  }

  // Multi-TF pin+FVG family — exit on bearish 4h pin bar
  if (templateName.startsWith("multi_tf_pin_fvg")) {
    return {
      exit_conditions: [
        { type: "pattern", pattern: "pin_bar", direction: "bearish", timeframe: "4h" },
      ],
      exit_logic: "any",
    };
  }

  // Multi-TF confluence (5-pattern) — exit on either bearish engulfing on 4h OR bearish daily_bias
  if (templateName.startsWith("multi_tf_confluence_5")) {
    return {
      exit_conditions: [
        { type: "pattern", pattern: "engulfing", direction: "bearish", timeframe: "4h" },
        {
          type: "pattern",
          pattern: "daily_bias",
          direction: "bearish",
          ma_period: 20,
          timeframe: "1d",
        },
      ],
      exit_logic: "any",
    };
  }

  // ICT BOS+OB — exit on bearish BOS
  if (templateName === "ict_bos_orderblock") {
    return {
      exit_conditions: [
        {
          type: "pattern",
          pattern: "bos",
          direction: "bearish",
          lookback: 5,
          timeframe: primaryTf,
        },
      ],
      exit_logic: "any",
    };
  }

  // ICT sweep+FVG — exit on bearish sweep (signal class flip)
  if (templateName === "ict_sweep_fvg_combo") {
    return {
      exit_conditions: [
        {
          type: "pattern",
          pattern: "liquidity_sweep",
          direction: "bearish",
          lookback: 5,
          timeframe: primaryTf,
        },
      ],
      exit_logic: "any",
    };
  }

  // RSI overbought fade (short) — exit on extreme overshoot (already in Candidate B live)
  if (templateName === "rsi_overbought_fade") {
    return {
      exit_conditions: [
        {
          type: "technical",
          indicator: "RSI",
          operator: "greater_than",
          value: 80,
          timeframe: primaryTf,
        },
      ],
      exit_logic: "any",
    };
  }

  // RSI oversold bounce (long) — exit on RSI overshooting to overbought (mean reversion done OR overshoot)
  if (templateName === "rsi_oversold_bounce") {
    return {
      exit_conditions: [
        {
          type: "technical",
          indicator: "RSI",
          operator: "less_than",
          value: 20,
          timeframe: primaryTf,
        },
      ],
      exit_logic: "any",
    };
  }

  // Bollinger lower bounce (long) — exit on RSI overbought as a proxy for mean-reversion done
  if (templateName === "bollinger_lower_bounce") {
    return {
      exit_conditions: [
        {
          type: "technical",
          indicator: "RSI",
          operator: "greater_than",
          value: 70,
          timeframe: primaryTf,
        },
      ],
      exit_logic: "any",
    };
  }

  return none;
}

interface BacktestSnapshot {
  trades: number;
  wr: number;
  return_usd: number;
  max_dd: number;
  wlr: number;
}

interface VetResult {
  rank: number;
  label: string;
  template_name: string;
  timeframe: string;
  side: string;
  search_score: number;
  search_monthly_pct: number;
  search_worst_dd: number;
  search_green_pct: number;
  no_exits: BacktestSnapshot;
  with_exits: BacktestSnapshot;
  exits_applied: number;
  verdict_with_exits: "PASS" | "FAIL";
  fail_reasons: string[];
}

let cached: Map<string, Map<string, PriceBar[]>> | null = null;

async function loadCorpus(
  symbols: string[],
  timeframes: string[]
): Promise<Map<string, Map<string, PriceBar[]>>> {
  if (cached) return cached;
  const intervals = new Set<BarInterval>();
  const intervalByTf = new Map<string, BarInterval>();
  for (const tf of timeframes) {
    const iv = timeframeToInterval(tf);
    intervals.add(iv);
    intervalByTf.set(tf, iv);
  }
  const byInterval = new Map<BarInterval, Map<string, PriceBar[]>>();
  for (const iv of intervals) byInterval.set(iv, new Map());
  for (const iv of intervals) {
    for (const sym of symbols) {
      try {
        const bars = await fetchDailyPrices(sym, "full", iv);
        if (bars.length >= 100) byInterval.get(iv)!.set(sym, bars);
      } catch {
        /* skip */
      }
    }
  }
  const out = new Map<string, Map<string, PriceBar[]>>();
  for (const [tf, iv] of intervalByTf) {
    const bars = byInterval.get(iv);
    if (bars) out.set(tf, bars);
  }
  cached = out;
  return out;
}

function snapshotFromBacktest(
  rules: AlgorithmRules,
  tfPrices: Map<string, PriceBar[]>,
  capital: number
): BacktestSnapshot {
  const result = runPortfolioBacktest(rules, tfPrices, capital, []);
  const trades: BacktestTrade[] = result.trades;
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0;
  return {
    trades: trades.length,
    wr: result.win_rate,
    return_usd: result.total_return,
    max_dd: result.max_drawdown,
    wlr: avgLoss !== 0 ? Math.abs(avgWin / avgLoss) : 0,
  };
}

function vetCandidate(
  candidate: CandidateResult,
  capital: number,
  corpus: Map<string, Map<string, PriceBar[]>>,
  rank: number
): VetResult {
  const templateName = candidate.label.split("__")[0];
  const side = candidate.rules.side ?? "long";

  const tfPrices = corpus.get(candidate.rules.timeframe);
  if (!tfPrices || tfPrices.size === 0) {
    const empty = { trades: 0, wr: 0, return_usd: 0, max_dd: 0, wlr: 0 };
    return {
      rank,
      label: candidate.label,
      template_name: templateName,
      timeframe: candidate.rules.timeframe,
      side,
      search_score: candidate.score,
      search_monthly_pct: candidate.monthly_return_pct,
      search_worst_dd: candidate.worst_dd_pct,
      search_green_pct: candidate.walk_forward.win_rate_of_windows * 100,
      no_exits: empty,
      with_exits: empty,
      exits_applied: 0,
      verdict_with_exits: "FAIL",
      fail_reasons: ["no-corpus"],
    };
  }

  // Pass 1: no exit conditions (search-emitted rules as-is).
  const noExits = snapshotFromBacktest(candidate.rules, tfPrices, capital);

  // Pass 2: with default signal-class exit conditions.
  const exits = defaultExitConditionsFor(templateName, candidate.rules.timeframe, side);
  const rulesWithExits: AlgorithmRules = {
    ...candidate.rules,
    exit_conditions: exits.exit_conditions,
    exit_logic: exits.exit_logic ?? candidate.rules.exit_logic,
  };
  const withExits =
    exits.exit_conditions.length > 0
      ? snapshotFromBacktest(rulesWithExits, tfPrices, capital)
      : noExits;

  // Verdict uses the WITH-exits snapshot — that's how the algo would deploy.
  const fail_reasons: string[] = [];
  if (withExits.trades < PASS_MIN_TRADES) fail_reasons.push(`trades<${PASS_MIN_TRADES}`);
  if (withExits.wr < PASS_MIN_WR_PCT) fail_reasons.push(`wr<${PASS_MIN_WR_PCT}%`);
  if (withExits.return_usd <= 0) fail_reasons.push("return≤0");
  if (withExits.max_dd > PASS_MAX_DD_PCT) fail_reasons.push(`dd>${PASS_MAX_DD_PCT}%`);

  return {
    rank,
    label: candidate.label,
    template_name: templateName,
    timeframe: candidate.rules.timeframe,
    side,
    search_score: candidate.score,
    search_monthly_pct: candidate.monthly_return_pct,
    search_worst_dd: candidate.worst_dd_pct,
    search_green_pct: candidate.walk_forward.win_rate_of_windows * 100,
    no_exits: noExits,
    with_exits: withExits,
    exits_applied: exits.exit_conditions.length,
    verdict_with_exits: fail_reasons.length === 0 ? "PASS" : "FAIL",
    fail_reasons,
  };
}

function fmtSnap(s: BacktestSnapshot): string {
  if (s.trades === 0) return "  no trades   ".padEnd(45);
  const trades = String(s.trades).padStart(3);
  const wr = `${s.wr.toFixed(1)}%`.padStart(6);
  const ret = (s.return_usd >= 0 ? "+" : "") + `$${s.return_usd.toFixed(0)}`.padStart(8);
  const dd = `${s.max_dd.toFixed(2)}%`.padStart(6);
  const wlr = s.wlr > 0 ? `${s.wlr.toFixed(2)}x`.padStart(6) : "  n/a ";
  const ev = ((s.wr / 100) * s.wlr - (1 - s.wr / 100)).toFixed(2);
  return `${trades}t ${wr} ${ret} ${dd} WLR ${wlr} EV ${ev.padStart(5)}R`;
}

function printRow(v: VetResult): void {
  const side = v.side.padEnd(5);
  const tf = v.timeframe.padEnd(4);
  const verdict = v.verdict_with_exits.padStart(4);
  const reasons = v.fail_reasons.length > 0 ? ` [${v.fail_reasons.join(",")}]` : "";
  console.log(
    `  #${String(v.rank).padStart(2)}  ${v.label.padEnd(50)}  ${tf} ${side}  ${verdict}${reasons}`
  );
  console.log(`        no-exits  : ${fmtSnap(v.no_exits)}`);
  console.log(
    `        with-exits: ${fmtSnap(v.with_exits)} ` +
      (v.exits_applied > 0 ? `(${v.exits_applied} exit cond)` : "(no exits applied)")
  );
}

async function main(): Promise<void> {
  const capital = Number(process.env.CAPITAL ?? "100000");
  const target = Number(process.env.TARGET ?? "10");
  const topN = Number(process.env.TOP_N ?? "10");
  const maxCandidates = Number(process.env.MAX_CANDIDATES ?? "80");
  const symbols = (process.env.SYMBOLS ?? "XAU/USD")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  console.log("Search-candidate vetting runner");
  console.log(`  capital     : $${capital.toLocaleString()}`);
  console.log(`  symbols     : ${symbols.join(", ")}`);
  console.log(`  top_n       : ${topN}  (after sort by score, descending)`);
  console.log(`  pass_rules  : trades ≥ ${PASS_MIN_TRADES}, wr ≥ ${PASS_MIN_WR_PCT}%, return > 0, dd ≤ ${PASS_MAX_DD_PCT}%`);
  console.log("");

  console.log("Running combinatorial search...");
  const start = Date.now();
  const searchResult = await runCombinatorialSearch(
    {
      capital,
      monthly_target_pct: target,
      prefer_symbols: symbols,
    },
    loadCorpus,
    {
      max_candidates: maxCandidates,
      top_n: topN,
      include_evaluated: true,
    }
  );
  console.log(`Search completed in ${((Date.now() - start) / 1000).toFixed(1)}s.`);
  console.log(
    `  candidates_evaluated: ${searchResult.candidates_evaluated}  candidates_passed (search): ${searchResult.candidates_passed}`
  );
  console.log("");

  const all = searchResult.all_evaluated ?? searchResult.top;
  if (all.length === 0) {
    console.log("No evaluated candidates returned. Aborting.");
    return;
  }

  const top = all.slice(0, topN);
  console.log(`Vetting top ${top.length} via fresh full-corpus backtest...\n`);

  const vetted: VetResult[] = [];
  if (!cached) {
    console.log("WARN: corpus cache empty after search; skipping fresh backtests.");
    return;
  }
  for (let i = 0; i < top.length; i++) {
    vetted.push(vetCandidate(top[i], capital, cached, i + 1));
  }

  console.log(
    "  rank label" + " ".repeat(48) + "  tf   side   verdict"
  );
  for (const v of vetted) printRow(v);

  const passers = vetted.filter((v) => v.verdict_with_exits === "PASS");
  const failers = vetted.filter((v) => v.verdict_with_exits === "FAIL");
  console.log("");
  console.log(`Summary: ${passers.length} PASS, ${failers.length} FAIL of ${vetted.length} vetted.`);
  if (passers.length > 0) {
    console.log("\nPASSing candidates (deployable as drafts at 1% risk_per_trade after exit_conditions added):");
    for (const v of passers) {
      const sideTag = v.side === "short" ? "SHORT" : v.side === "auto" ? "AUTO" : "LONG";
      console.log(`  - [${sideTag.padEnd(5)} ${v.timeframe.padEnd(4)}] ${v.label}`);
    }
  }
  if (failers.length > 0) {
    console.log("\nFAILing candidates (search rank misleading on long corpus — DO NOT deploy):");
    for (const v of failers) {
      console.log(`  - ${v.label.padEnd(50)} ${v.fail_reasons.join(", ")}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
