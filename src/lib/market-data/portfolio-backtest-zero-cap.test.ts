/**
 * B.1.22 — zero-cap gate-config edge case tests (2026-06-22 NIGHT LATE).
 *
 * Two pathological configurations were untested:
 *
 *   1. `pool_cap_pct = 0` on the risk-pool gate — any candidate with
 *      positive risk should block. Comparison is strict `combinedPct >
 *      poolCapPct`, so candidateRisk=0 + empty siblings is the ONE case
 *      that passes through.
 *
 *   2. `daily_loss_limit_pct = 0` on the portfolio-halt gate — comparison
 *      is `combinedPct <= -daily_loss_limit_pct`, so combinedPct=0 (any
 *      break-even or losing day) trips. Only a winning day passes.
 *
 * Both configurations are operator-error inputs (the env-var validator
 * shouldn't actually accept them), but the gate-layer's behavior under
 * these inputs is the structural contract: gates fail closed, not
 * silently open. Lock the contract so a future refactor that flips a
 * comparator (e.g., `>` → `>=`) can't accidentally make zero-cap a no-op.
 *
 * Coverage (10 tests):
 *
 *  hasRiskPoolBreach with pool_cap_pct=0 (4):
 *   - Positive candidate risk, no siblings → BREACH (block)
 *   - Zero candidate risk, no siblings → NO breach (degenerate pass-through)
 *   - Positive candidate + positive sibling risk → BREACH (any non-zero combined breaches)
 *   - refCapital=0 short-circuits to BREACH BEFORE the zero-cap math runs (B.1.17 interaction)
 *
 *  hasPortfolioHaltBreach with daily_loss_limit_pct=0 (4):
 *   - Negative myDailyPnl → BREACH (any losing day trips)
 *   - Zero myDailyPnl + no sibling P&L → BREACH (combined=0 satisfies <= -0)
 *   - Positive myDailyPnl + zero sibling → NO breach (only winning days pass)
 *   - Negative sibling P&L overwhelms positive my P&L → BREACH
 *
 *  Composition stability (2):
 *   - Both gates at zero-cap on the same runPortfolioBacktest → no crash, no NaN
 *   - Zero-cap configs ≡ "no entries permitted" semantically (0 trades survive
 *     both gates simultaneously)
 */
import { describe, expect, it } from "vitest";
import type { AlgorithmRules } from "@/types/algorithm";
import {
  hasPortfolioHaltBreach,
  hasRiskPoolBreach,
  runPortfolioBacktest,
  type PortfolioHaltConfig,
  type RiskPoolConfig,
  type SiblingTradeWindow,
} from "./portfolio-backtest";
import type { PriceBar } from "./types";

function bar(date: string, o: number, h: number, l: number, c: number): PriceBar {
  return { date, open: o, high: h, low: l, close: c, volume: 0 };
}

const baseRules: AlgorithmRules = {
  asset_class: "commodity",
  side: "long",
  timeframe: "4h",
  entry_conditions: [
    { type: "technical", indicator: "rsi", operator: "less_than", value: 50, timeframe: "4h" },
  ],
  exit_conditions: [
    { type: "technical", indicator: "rsi", operator: "greater_than", value: 70, timeframe: "4h" },
  ],
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
  // Two cycles of up-down-up; enough opportunities for ≥1 baseline trade.
  for (let cycle = 0; cycle < 3; cycle++) {
    for (let i = 0; i < 20; i++) { bars.push(bar(next(), price, price + 1, price - 0.5, price + 0.8)); price += 0.8; }
    for (let i = 0; i < 15; i++) { bars.push(bar(next(), price, price + 0.3, price - 2, price - 1.5)); price -= 1.5; }
    for (let i = 0; i < 10; i++) { bars.push(bar(next(), price, price + 1.5, price - 0.3, price + 1.2)); price += 1.2; }
  }
  return bars;
}

const fixture = makeFixture();
const prices = new Map([["XAU/USD", fixture]]);

// ======================================================================
// hasRiskPoolBreach with pool_cap_pct=0 (4 tests)
// ======================================================================

describe("hasRiskPoolBreach — pool_cap_pct=0 edge case (B.1.22)", () => {
  const refCapital = 10_000;
  const date = "2026-06-15T00:00:00Z";

  it("positive candidate risk + no siblings → BREACH (block)", () => {
    const breach = hasRiskPoolBreach(
      [], // no siblings
      100, // candidate $100 risk
      date,
      refCapital,
      0 // pool_cap_pct = 0
    );
    expect(breach).toBe(true);
  });

  it("zero candidate risk + no siblings → NO breach (degenerate pass-through)", () => {
    // combinedPct = (0 + 0) / 10000 × 100 = 0; 0 > 0 is false → no breach
    const breach = hasRiskPoolBreach([], 0, date, refCapital, 0);
    expect(breach).toBe(false);
  });

  it("positive candidate + positive sibling risk → BREACH (any non-zero combined breaches)", () => {
    const siblings: SiblingTradeWindow[] = [
      { ticker: "XAU/USD", side: "long", entry_date: "2026-06-01T00:00:00Z", exit_date: "2026-06-30T00:00:00Z", risk_dollars: 50 },
    ];
    const breach = hasRiskPoolBreach(siblings, 50, date, refCapital, 0);
    expect(breach).toBe(true);
  });

  it("refCapital=0 short-circuits to BREACH BEFORE zero-cap math (B.1.17 interaction)", () => {
    // B.1.17 fail-closed: refCapital ≤ 0 → breach regardless of cap value.
    // Verify the short-circuit happens BEFORE the zero-cap path, so a
    // dead-account state can't accidentally produce NaN from 0/0.
    const breach = hasRiskPoolBreach([], 100, date, 0, 0);
    expect(breach).toBe(true);
  });
});

// ======================================================================
// hasPortfolioHaltBreach with daily_loss_limit_pct=0 (4 tests)
// ======================================================================

describe("hasPortfolioHaltBreach — daily_loss_limit_pct=0 edge case (B.1.22)", () => {
  const fallbackCapital = 10_000;
  const dayKey = "2026-06-15";

  function makeConfig(dailyLossLimitPct: number, siblingPnl: Record<string, number> = {}): PortfolioHaltConfig {
    return {
      enabled: true,
      daily_loss_limit_pct: dailyLossLimitPct,
      reference_capital: 10_000,
      sibling_daily_pnl: siblingPnl,
    };
  }

  it("negative myDailyPnl → BREACH (any losing day trips at dll=0)", () => {
    // combined = -50 + 0 = -50; combinedPct = -0.5; -0.5 ≤ -0 → BREACH
    const breach = hasPortfolioHaltBreach(makeConfig(0), dayKey, -50, fallbackCapital);
    expect(breach).toBe(true);
  });

  it("zero myDailyPnl + no sibling P&L → BREACH (combined=0 satisfies <= -0)", () => {
    // combinedPct = 0; 0 ≤ -0 → true → BREACH. This is the strictest
    // intent: dll=0 means "no daily loss tolerated, period." The
    // gate-layer interprets combined=0 (break-even) as the boundary
    // case that trips.
    const breach = hasPortfolioHaltBreach(makeConfig(0), dayKey, 0, fallbackCapital);
    expect(breach).toBe(true);
  });

  it("positive myDailyPnl + zero sibling P&L → NO breach (only winning days pass)", () => {
    // combinedPct = +0.5; 0.5 ≤ -0 → false → no breach
    const breach = hasPortfolioHaltBreach(makeConfig(0), dayKey, 50, fallbackCapital);
    expect(breach).toBe(false);
  });

  it("negative sibling P&L overwhelms positive my P&L → BREACH", () => {
    // sibling=-200, my=+50 → combined=-150 → combinedPct=-1.5 → ≤ -0 → BREACH
    const cfg = makeConfig(0, { [dayKey]: -200 });
    const breach = hasPortfolioHaltBreach(cfg, dayKey, 50, fallbackCapital);
    expect(breach).toBe(true);
  });
});

// ======================================================================
// Composition stability — both gates at zero-cap simultaneously
// ======================================================================

describe("zero-cap composition stability (B.1.22)", () => {
  it("both gates at zero-cap → runPortfolioBacktest completes without crash/NaN", () => {
    const result = runPortfolioBacktest(baseRules, prices, 10_000, {
      riskPool: { enabled: true, pool_cap_pct: 0, reference_capital: 10_000 } satisfies RiskPoolConfig,
      portfolioHalt: {
        enabled: true,
        daily_loss_limit_pct: 0,
        reference_capital: 10_000,
        sibling_daily_pnl: {},
      } satisfies PortfolioHaltConfig,
    });
    // No crash. total_return must be finite even if zero entries fire.
    expect(Number.isFinite(result.total_return)).toBe(true);
    // Every trade (if any survived) must have valid fields.
    for (const t of result.trades) {
      expect(Number.isFinite(t.pnl)).toBe(true);
      expect(t.side === "long" || t.side === "short").toBe(true);
    }
  });

  it("zero-cap risk-pool ≡ 'no entries permitted' (POOL_CAP_PCT=0 produces 0 trades)", () => {
    // With pool_cap_pct=0, any candidate with positive risk gets blocked.
    // Since baseRules uses risk_per_trade=1 (1% of capital), every
    // candidate carries positive risk → 0 trades expected.
    const result = runPortfolioBacktest(baseRules, prices, 10_000, {
      riskPool: { enabled: true, pool_cap_pct: 0, reference_capital: 10_000 } satisfies RiskPoolConfig,
      // Need a sibling entry to make the risk-pool gate actually evaluate
      // (the gate is keyed on sibling presence in some code paths). Empty
      // siblings + zero cap should still produce zero trades because the
      // candidate's own risk_dollars contribution alone exceeds cap=0.
      riskPoolSiblings: [],
    });
    expect(result.trades.length).toBe(0);
  });
});
