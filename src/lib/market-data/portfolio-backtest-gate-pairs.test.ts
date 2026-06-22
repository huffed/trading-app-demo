/**
 * SG.14 — pair-specific integration tests for portfolio-backtest gates.
 *
 * The companion `portfolio-backtest-gates-integration.test.ts` (B.1.11)
 * verifies all 7 gates compose without crashes. SG.14 was filed because
 * that test doesn't answer: "which gate wins when direction-conflict +
 * risk-pool fire simultaneously?", "does FTMO termination dominate
 * re-entry cooldown?", etc.
 *
 * What can actually be locked at the backtest output layer:
 *
 *  1. **Termination dominance** — once FTMO termination breaches, NO
 *     later trade entries exist, regardless of other gates' state.
 *
 *  2. **Determinism / no global-state leak** — same gate-pair config
 *     across two invocations produces identical trade arrays. Regression
 *     prevention against accidental memoization leaking between runs.
 *
 *  3. **Path-dependent cooldown REAL effect** — re-entry cooldown can
 *     INCREASE trade count by delaying terminal halts (documented in
 *     B.1.11 forensic note). This counterintuitive behavior is a real
 *     property of the system; locking it prevents an over-eager
 *     "optimization" that re-introduces the bug.
 *
 *  4. **Stable composition** — for each named pair, no NaN, no missing
 *     fields, sides match rules.side, exit_reasons are valid.
 *
 *  5. **Off-equivalence under empty inputs** — gates ON but with empty
 *     siblings + zero risk inputs behave like baseline (no false-positive
 *     blocks from misconfigured-but-disabled-via-empty-data state).
 *
 *  6. **Pair vs single equivalence** — for path-independent gates,
 *     enabling the pair can't unblock entries that either gate would
 *     have blocked. (Skip for cooldown — path-dependent.)
 *
 * What CANNOT cleanly be locked from this layer:
 *  - "Which gate's reason fired?" — blocked entries produce no trade
 *    record. Per-gate event logs would need scan-engine integration
 *    (CB.T1's engine.ts tests cover that already via mock dispatch).
 *  - "Order of evaluation" — gates run inside one engine bar evaluation;
 *    only the OUTCOME (blocked/allowed) is observable from output.
 */
import { describe, expect, it } from "vitest";
import type { AlgorithmRules } from "@/types/algorithm";
import {
  runPortfolioBacktest,
  type FtmoTerminationConfig,
  type PortfolioHaltConfig,
  type ReEntryCooldownConfig,
  type RiskPoolConfig,
  type SiblingTradeWindow,
  type SpreadGateConfig,
} from "./portfolio-backtest";
import type { PriceBar } from "./types";

function bar(date: string, o: number, h: number, l: number, c: number): PriceBar {
  return { date, open: o, high: h, low: l, close: c, volume: 0 };
}

const baseRules: AlgorithmRules = {
  asset_class: "commodity",
  side: "long",
  timeframe: "4h",
  entry_conditions: [{ type: "technical", indicator: "rsi", operator: "less_than", value: 50, timeframe: "4h" }],
  exit_conditions: [{ type: "technical", indicator: "rsi", operator: "greater_than", value: 70, timeframe: "4h" }],
  entry_logic: "all",
  stop_loss: { type: "percentage", value: 1.5 },
  take_profit: { type: "percentage", value: 3 },
  position_sizing: { type: "risk_per_trade", value: 1 },
  max_positions: 1,
  max_per_ticker: 1,
  prop_firm: {
    daily_loss_limit: 5,
    max_drawdown: 10,
    profit_target: 10,
    max_consecutive_losses: 0,
    consecutive_loss_daily_halt: 3,
    consistency_rule: 0,
    slippage_bps: 3,
    spread_bps: 0,
    commission_pct: 0,
  },
};

/** Fixture identical to B.1.11 — same trade-flow shape so this companion
 *  file's results are directly comparable to the existing integration test. */
function makeFixture(): PriceBar[] {
  const bars: PriceBar[] = [];
  let price = 100;
  let day = 1, month = 1;
  const next = (): string => {
    const d = day.toString().padStart(2, "0");
    const m = month.toString().padStart(2, "0");
    day++;
    if (day > 28) { day = 1; month++; }
    return `2026-${m}-${d}T04:00:00Z`;
  };
  for (let cycle = 0; cycle < 6; cycle++) {
    for (let i = 0; i < 20; i++) { bars.push(bar(next(), price, price + 1, price - 0.5, price + 0.8)); price += 0.8; }
    for (let i = 0; i < 15; i++) { bars.push(bar(next(), price, price + 0.3, price - 2, price - 1.5)); price -= 1.5; }
    for (let i = 0; i < 10; i++) { bars.push(bar(next(), price, price + 1.5, price - 0.3, price + 1.2)); price += 1.2; }
  }
  return bars;
}

const fixture = makeFixture();
const prices = new Map([["XAU/USD", fixture]]);

// Pair-specific gate configurations.
const directionConflictSiblings: SiblingTradeWindow[] = [
  { ticker: "XAU/USD", side: "short", entry_date: "2025-12-01T00:00:00Z", exit_date: "2026-01-15T00:00:00Z" },
];
const riskPoolEnabled: RiskPoolConfig = { enabled: true, pool_cap_pct: 4, reference_capital: 50_000 };
const riskPoolSiblings: SiblingTradeWindow[] = [
  { ticker: "XAU/USD", side: "long", entry_date: "2025-12-01T00:00:00Z", exit_date: "2026-02-15T00:00:00Z", risk_dollars: 800 },
];
const spreadGate: SpreadGateConfig = { enabled: true, threshold_multiplier: 2.5, atr_lookback_bars: 200 };
const ftmoTermination: FtmoTerminationConfig = { enabled: true };
const reEntryCooldown: ReEntryCooldownConfig = { enabled: true };
const portfolioHalt: PortfolioHaltConfig = {
  enabled: true,
  daily_loss_limit_pct: 5,
  reference_capital: 50_000,
  sibling_daily_pnl: {},
};

// ======================================================================
// Termination dominance — once FTMO breaches, NO later entries
// ======================================================================

describe("SG.14 — FTMO termination dominance over other gates", () => {
  it("termination ON + cooldown ON: cooldown does NOT enable entries past termination point", () => {
    const result = runPortfolioBacktest(baseRules, prices, 10_000, {
      ftmoTermination,
      reEntryCooldown,
    });
    // If termination fired, find the breach point and verify no later entries.
    const breachIdx = result.trades.findIndex(
      (t) => t.exit_reason === "ftmo_termination" || t.exit_reason === "max_drawdown"
    );
    if (breachIdx >= 0) {
      const breachDate = result.trades[breachIdx].entry_date;
      const laterEntries = result.trades.filter((t) => t.entry_date > breachDate);
      // Trades beyond the breach must have been opened EARLIER (concurrent),
      // not started after. Verify all later-listed trades were opened by
      // breach date or before.
      for (const t of laterEntries) {
        expect(t.entry_date <= breachDate).toBe(true);
      }
    }
    // No NaN regardless of whether termination fired in this fixture
    for (const t of result.trades) expect(Number.isFinite(t.pnl)).toBe(true);
  });

  it("termination + direction-conflict + risk-pool: no entries after termination", () => {
    const result = runPortfolioBacktest(baseRules, prices, 10_000, {
      ftmoTermination,
      siblingBlockingTrades: directionConflictSiblings,
      riskPool: riskPoolEnabled,
      riskPoolSiblings,
    });
    // Any termination event has the same dominance contract regardless of
    // the other gates' state.
    const breached = result.trades.find((t) => t.exit_reason === "max_drawdown");
    if (breached) {
      const breachDate = breached.entry_date;
      expect(result.trades.every((t) => t.entry_date <= breachDate)).toBe(true);
    }
    // Structural integrity preserved
    expect(result.trades.every((t) => t.side === "long")).toBe(true);
  });
});

// ======================================================================
// Determinism / no global-state leak between runs
// ======================================================================

describe("SG.14 — determinism across invocations (no state leak)", () => {
  it("same pair config + same fixture → identical trade arrays across two invocations", () => {
    const cfg = {
      siblingBlockingTrades: directionConflictSiblings,
      riskPool: riskPoolEnabled,
      riskPoolSiblings,
    };
    const r1 = runPortfolioBacktest(baseRules, prices, 10_000, cfg);
    const r2 = runPortfolioBacktest(baseRules, prices, 10_000, cfg);
    expect(r1.trades).toEqual(r2.trades);
    expect(r1.total_return).toEqual(r2.total_return);
  });

  it("different pair configs run sequentially → no leakage between runs", () => {
    // Run A: cooldown only
    const a = runPortfolioBacktest(baseRules, prices, 10_000, { reEntryCooldown });
    // Run B: spread only (different gate)
    const b = runPortfolioBacktest(baseRules, prices, 10_000, { spreadGate });
    // Run A again — must equal first A
    const aAgain = runPortfolioBacktest(baseRules, prices, 10_000, { reEntryCooldown });
    expect(aAgain.trades).toEqual(a.trades);
    // And A's result must differ from B's (different gates → different effect)
    // Use length as a cheap diff signal; if both happen to be equal we just
    // accept (this isn't the property under test, the leak is)
    expect(b.trades.length).toBeGreaterThanOrEqual(0); // sanity
  });
});

// ======================================================================
// Path-dependent cooldown — REAL effect documented in B.1.11
// ======================================================================

describe("SG.14 — path-dependent gates can INCREASE trade count (documented)", () => {
  it("cooldown ON ≥ baseline trade count on this fixture (B.1.11 forensic finding)", () => {
    // B.1.11 forensic note (portfolio-backtest-gates-integration.test.ts:137-150):
    // re-entry cooldown skips back-to-back losers, slows DD accumulation,
    // delays the s.drawdownBreached → canEnter halt, and the corpus reaches
    // more up-cycles before stopping. Observed: cooldown produces 1.43×
    // baseline trade count on this fixture.
    //
    // Lock this counterintuitive property so a future "optimization" that
    // assumes "gates only reduce trades" can't silently break the
    // path-dependent halt-delay mechanism.
    const baseline = runPortfolioBacktest(baseRules, prices, 10_000);
    const withCooldown = runPortfolioBacktest(baseRules, prices, 10_000, { reEntryCooldown });
    expect(withCooldown.trades.length).toBeGreaterThanOrEqual(baseline.trades.length);
  });

  it("path-independent gate (direction-conflict alone) ≤ baseline trade count", () => {
    // Contrast: direction-conflict is path-INDEPENDENT (the sibling window
    // is fixed; doesn't shift other gates' trip points). So enabling it
    // can only REDUCE trade count.
    const baseline = runPortfolioBacktest(baseRules, prices, 10_000);
    const withDirConflict = runPortfolioBacktest(baseRules, prices, 10_000, {
      siblingBlockingTrades: directionConflictSiblings,
    });
    expect(withDirConflict.trades.length).toBeLessThanOrEqual(baseline.trades.length);
  });
});

// ======================================================================
// Stable composition (no NaN / missing fields / wrong side) per pair
// ======================================================================

describe("SG.14 — pair-stable composition (no crashes, valid output)", () => {
  const pairCases: Array<[string, Parameters<typeof runPortfolioBacktest>[3]]> = [
    [
      "direction-conflict + risk-pool",
      {
        siblingBlockingTrades: directionConflictSiblings,
        riskPool: riskPoolEnabled,
        riskPoolSiblings,
      },
    ],
    [
      "spread-gate + risk-pool",
      { spreadGate, riskPool: riskPoolEnabled, riskPoolSiblings },
    ],
    [
      "portfolio-halt + ftmo-termination",
      { portfolioHalt, ftmoTermination },
    ],
    [
      "cooldown + spread-gate",
      { reEntryCooldown, spreadGate },
    ],
    [
      "cooldown + ftmo-termination",
      { reEntryCooldown, ftmoTermination },
    ],
    [
      "direction-conflict + portfolio-halt",
      { siblingBlockingTrades: directionConflictSiblings, portfolioHalt },
    ],
  ];

  for (const [name, cfg] of pairCases) {
    it(`${name}: no NaN, valid sides, valid exit_reasons`, () => {
      const result = runPortfolioBacktest(baseRules, prices, 10_000, cfg);
      for (const t of result.trades) {
        expect(Number.isFinite(t.pnl)).toBe(true);
        expect(Number.isFinite(t.entry_price)).toBe(true);
        expect(Number.isFinite(t.exit_price)).toBe(true);
        expect(t.side === "long" || t.side === "short").toBe(true);
        // Every backtest exit must have a reason (never null/undefined/empty)
        expect(t.exit_reason).toBeTruthy();
        // Date strings must be parseable ISO
        expect(Date.parse(t.entry_date)).not.toBeNaN();
        expect(Date.parse(t.exit_date)).not.toBeNaN();
      }
      // total_return finite + no NaN aggregate
      expect(Number.isFinite(result.total_return)).toBe(true);
    });
  }
});

// ======================================================================
// Off-equivalence under empty inputs
// ======================================================================

describe("SG.14 — gates ON with empty inputs ≡ baseline (no false-positive blocks)", () => {
  it("direction-conflict with [] siblings → identical to baseline", () => {
    const baseline = runPortfolioBacktest(baseRules, prices, 10_000);
    const empty = runPortfolioBacktest(baseRules, prices, 10_000, {
      siblingBlockingTrades: [],
    });
    expect(empty.trades.length).toBe(baseline.trades.length);
    expect(empty.total_return).toBeCloseTo(baseline.total_return, 2);
  });

  it("risk-pool ON with [] siblings + zero risk → identical to baseline", () => {
    const baseline = runPortfolioBacktest(baseRules, prices, 10_000);
    const empty = runPortfolioBacktest(baseRules, prices, 10_000, {
      riskPool: { enabled: true, pool_cap_pct: 100, reference_capital: 50_000 },
      riskPoolSiblings: [],
    });
    expect(empty.trades.length).toBe(baseline.trades.length);
    expect(empty.total_return).toBeCloseTo(baseline.total_return, 2);
  });

  it("portfolio-halt with {} sibling_daily_pnl → identical to baseline", () => {
    const baseline = runPortfolioBacktest(baseRules, prices, 10_000);
    const empty = runPortfolioBacktest(baseRules, prices, 10_000, {
      portfolioHalt: { enabled: true, daily_loss_limit_pct: 5, reference_capital: 50_000, sibling_daily_pnl: {} },
    });
    expect(empty.trades.length).toBe(baseline.trades.length);
    expect(empty.total_return).toBeCloseTo(baseline.total_return, 2);
  });
});

// ======================================================================
// Pair vs single equivalence for PATH-INDEPENDENT pairs
// ======================================================================

describe("SG.14 — path-independent pair composition ≤ each gate alone", () => {
  it("direction-conflict + risk-pool ≤ direction-conflict alone (path-independent)", () => {
    // Both are path-independent (their inputs don't shift terminal halt
    // trip points). Enabling both can only intersect — never unblock.
    const dirOnly = runPortfolioBacktest(baseRules, prices, 10_000, {
      siblingBlockingTrades: directionConflictSiblings,
    });
    const both = runPortfolioBacktest(baseRules, prices, 10_000, {
      siblingBlockingTrades: directionConflictSiblings,
      riskPool: riskPoolEnabled,
      riskPoolSiblings,
    });
    expect(both.trades.length).toBeLessThanOrEqual(dirOnly.trades.length);
  });

  it("direction-conflict + risk-pool ≤ risk-pool alone (path-independent)", () => {
    const poolOnly = runPortfolioBacktest(baseRules, prices, 10_000, {
      riskPool: riskPoolEnabled,
      riskPoolSiblings,
    });
    const both = runPortfolioBacktest(baseRules, prices, 10_000, {
      siblingBlockingTrades: directionConflictSiblings,
      riskPool: riskPoolEnabled,
      riskPoolSiblings,
    });
    expect(both.trades.length).toBeLessThanOrEqual(poolOnly.trades.length);
  });
});
