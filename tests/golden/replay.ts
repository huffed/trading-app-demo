/**
 * Golden-file replay: the five deployed XAU/USD 4h algorithms run through the
 * backtest engine on the pinned H4/D1 corpora over 2026-01-01 → 2026-07-09,
 * twice — at the paper capital ($100K) and at the baseline harness's $10K
 * pool where the 0.01-lot floor bites — and the resulting trade lists are
 * compared with tests/golden/xau-usd-h4-2026h1.golden.json.
 *
 * Any change that alters a trade (entry, exit, price, P&L, reason, R) or the
 * set of trades fails `make backtest` and the vitest test unless the golden
 * file is regenerated on purpose (`pnpm exec tsx scripts/golden-replay.ts --update`)
 * and committed with an explanation.
 *
 * Window: the H4 pin ends 2026-07-09; the audit's locked window starts
 * 2026-07-10. Bars from 2025-10-01 are fed as warm-up so every gate (ATR
 * percentile over 200 bars, regime over 90 days, SMA20 daily bias) is armed on
 * 2026-01-01; trades that open before the window are counted but not listed.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  runPortfolioBacktest,
  type RunPortfolioBacktestOptions,
} from "@/lib/market-data/portfolio-backtest";
import type { BacktestTrade, PriceBar } from "@/lib/market-data/types";
import { algorithmRulesSchema } from "@/lib/validators/algorithm";
import type { AlgorithmRules } from "@/types/algorithm";
import { loadPinnedBars, sessionDailyClose } from "../../scripts/canonical/lib/pinned-eval";

export const GOLDEN_PATH = join(__dirname, "xau-usd-h4-2026h1.golden.json");
export const RULES_FIXTURE_PATH = join(__dirname, "deployed-rules-2026-10-28.json");

export const WINDOW = { warmupFrom: "2025-10-01", from: "2026-01-01", to: "2026-07-09" } as const;
export const TICKER = "XAU/USD";

/** Engine options shared by both runs: solo (no siblings), session-close
 *  dailies for the bias, the ATR spread proxy and the re-entry cooldown on,
 *  no news events, no FTMO termination — the same shape the baseline
 *  harness (e2.22-layer-b-pinned MODE=algo-stats) used minus the sibling
 *  gates, which need the other algos' trades and are covered by the
 *  characterisation tests instead. */
export const ENGINE_OPTIONS = {
  spreadGate: { enabled: true, threshold_multiplier: 2.5, atr_lookback_bars: 200 },
  reEntryCooldown: { enabled: true },
  events: [] as const,
} as const;

export const RUNS = {
  "100k_paper_capital": {
    capital: 100_000,
    note: "the paper book's capital; the engine's 0.01-lot floor rarely binds here",
  },
  "10k_pool_floor": {
    capital: 10_000,
    note: "the baseline harness's pool; the 0.01-lot floor skips small signals",
  },
} as const;

export interface GoldenTrade {
  algorithm: string;
  entry_date: string;
  exit_date: string;
  entry_price: number;
  exit_price: number;
  side: "long" | "short";
  pnl: number;
  /** pnl / (equity_at_entry × risk %) — the baseline harness's per-trade R. */
  r_nominal: number | null;
  exit_reason: string;
  mae: number | null;
  equity_at_entry: number | null;
}

export interface GoldenRun {
  capital: number;
  trade_count: number;
  warmup_trade_count: number;
  total_pnl: number;
  trades: GoldenTrade[];
}

export interface GoldenFile {
  generated_at: string;
  window: typeof WINDOW;
  engine_options: typeof ENGINE_OPTIONS;
  inputs: {
    h4_sha256: string;
    d_sha256: string;
    h4_bars_fed: number;
    rules_fixture_sha256: string;
  };
  runs: Record<keyof typeof RUNS, GoldenRun>;
}

interface RulesFixture {
  algorithms: { id: string; name: string; rules: unknown }[];
}

/** "Deploy: XAU/USD ARB+DailyBias 4h | r085 v1" → "ARB+DailyBias 4h" */
function shortName(name: string): string {
  return name.replace(/^Deploy:\s*XAU\/USD\s*/, "").replace(/\s*\|.*$/, "");
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function loadRulesFixture(): {
  algorithms: { name: string; rules: AlgorithmRules }[];
  sha256: string;
} {
  const text = readFileSync(RULES_FIXTURE_PATH, "utf8");
  const fixture = JSON.parse(text) as RulesFixture;
  const algorithms = fixture.algorithms.map((a) => ({
    name: shortName(a.name),
    rules: algorithmRulesSchema.parse(a.rules) as AlgorithmRules,
  }));
  // Hash the canonical serialisation, not the file text: prettier re-wrapping the
  // fixture at commit time must not read as "the rules changed".
  return { algorithms, sha256: sha256(JSON.stringify(fixture)) };
}

function toGoldenTrade(algorithm: string, t: BacktestTrade, riskPct: number): GoldenTrade {
  const riskDollars = t.equity_at_entry != null ? t.equity_at_entry * (riskPct / 100) : null;
  return {
    algorithm,
    entry_date: t.entry_date,
    exit_date: t.exit_date,
    entry_price: Number(t.entry_price.toFixed(5)),
    exit_price: Number(t.exit_price.toFixed(5)),
    side: t.side,
    pnl: Number(t.pnl.toFixed(2)),
    r_nominal: riskDollars ? Number((t.pnl / riskDollars).toFixed(4)) : null,
    exit_reason: t.exit_reason ?? "unknown",
    mae: t.mae != null ? Number(t.mae.toFixed(2)) : null,
    equity_at_entry: t.equity_at_entry != null ? Number(t.equity_at_entry.toFixed(2)) : null,
  };
}

export function replayGolden(): GoldenFile {
  const h4 = loadPinnedBars(TICKER, "h4");
  const d1 = loadPinnedBars(TICKER, "d");
  const bars: PriceBar[] = h4.bars.filter(
    (b) => b.date >= WINDOW.warmupFrom && b.date <= `${WINDOW.to}T23:59:59Z`
  );
  const dailies = sessionDailyClose(d1.bars);
  const { algorithms, sha256: rulesSha } = loadRulesFixture();

  const runs: Partial<Record<keyof typeof RUNS, GoldenRun>> = {};
  for (const [runKey, run] of Object.entries(RUNS) as [
    keyof typeof RUNS,
    (typeof RUNS)[keyof typeof RUNS],
  ][]) {
    const trades: GoldenTrade[] = [];
    let warmup = 0;
    for (const algo of algorithms) {
      const options: RunPortfolioBacktestOptions = {
        spreadGate: { ...ENGINE_OPTIONS.spreadGate },
        reEntryCooldown: { ...ENGINE_OPTIONS.reEntryCooldown },
        events: [],
        dailyBarsOverride: dailies,
      };
      const result = runPortfolioBacktest(
        algo.rules,
        new Map([[TICKER, bars]]),
        run.capital,
        options
      );
      const riskPct = algo.rules.position_sizing.value;
      for (const t of result.trades) {
        if (t.entry_date < WINDOW.from) {
          warmup += 1;
          continue;
        }
        trades.push(toGoldenTrade(algo.name, t, riskPct));
      }
    }
    trades.sort(
      (a, b) => a.entry_date.localeCompare(b.entry_date) || a.algorithm.localeCompare(b.algorithm)
    );
    runs[runKey] = {
      capital: run.capital,
      trade_count: trades.length,
      warmup_trade_count: warmup,
      total_pnl: Number(trades.reduce((s, t) => s + t.pnl, 0).toFixed(2)),
      trades,
    };
  }

  return {
    generated_at: new Date().toISOString(),
    window: WINDOW,
    engine_options: ENGINE_OPTIONS,
    inputs: {
      h4_sha256: h4.sha256,
      d_sha256: d1.sha256,
      h4_bars_fed: bars.length,
      rules_fixture_sha256: rulesSha,
    },
    runs: runs as Record<keyof typeof RUNS, GoldenRun>,
  };
}

export function readGolden(): GoldenFile {
  return JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as GoldenFile;
}

/** Everything except the generation timestamp. */
export function comparable(g: GoldenFile): Omit<GoldenFile, "generated_at"> {
  const { generated_at: _ignored, ...rest } = g;
  return rest;
}
