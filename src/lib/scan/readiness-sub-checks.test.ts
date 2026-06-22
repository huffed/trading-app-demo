/**
 * CB.T1 Tier 3 — readiness-sub-checks.ts (2026-06-23).
 *
 * Pure check functions used by the admin UI promotion-eligibility surface.
 * Tests:
 *   - combineSeverity: fail > caution > pass
 *   - walkForwardCheck: insufficient windows → caution; green<70% → caution;
 *     worst window DD breach → fail; happy path → pass
 *   - pairQualityCheck: losers → fail; no samples → caution; all good → pass
 *   - sideSymmetryCheck: auto → caution; fixed → pass
 *   - ftmoFitCheck: risk>1% → caution; halt=0 → caution; both ok → pass
 */
import { describe, expect, it } from "vitest";
import type { AlgorithmRules } from "@/types/algorithm";
import {
  combineSeverity,
  ftmoFitCheck,
  pairQualityCheck,
  sideSymmetryCheck,
  walkForwardCheck,
  type PairStat,
  type WalkForwardSummary,
} from "./readiness-sub-checks";

function makeWfSummary(overrides: Partial<WalkForwardSummary> = {}): WalkForwardSummary {
  return {
    total_windows: 10,
    mean_win_rate: 50,
    mean_return: 1000,
    mean_drawdown: 4,
    win_rate_of_windows: 0.8,
    windows: Array.from({ length: 10 }, () => ({ total_return: 100, max_drawdown: 5 })),
    ...overrides,
  };
}

describe("combineSeverity", () => {
  it("any fail → fail", () => {
    expect(combineSeverity(["pass", "pass", "fail", "caution"])).toBe("fail");
  });
  it("no fail + any caution → caution", () => {
    expect(combineSeverity(["pass", "pass", "caution"])).toBe("caution");
  });
  it("all pass → pass", () => {
    expect(combineSeverity(["pass", "pass", "pass"])).toBe("pass");
  });
  it("empty → pass (default)", () => {
    expect(combineSeverity([])).toBe("pass");
  });
});

describe("walkForwardCheck", () => {
  it("insufficient windows (<3) → caution", () => {
    const r = walkForwardCheck(makeWfSummary({ total_windows: 2 }), 10_000, 60);
    expect(r.severity).toBe("caution");
    expect(r.reason).toContain("Only 2 window");
  });

  it("happy path → pass", () => {
    const r = walkForwardCheck(makeWfSummary(), 10_000, 60);
    expect(r.severity).toBe("pass");
  });

  it("green window rate < 70% → caution", () => {
    const r = walkForwardCheck(makeWfSummary({ win_rate_of_windows: 0.5 }), 10_000, 60);
    expect(r.severity).toBe("caution");
    expect(r.reason).toContain("only 50% of windows green");
  });

  it("worst window DD ≥ 10% (FTMO limit) → fail", () => {
    const windows = [
      ...Array.from({ length: 9 }, () => ({ total_return: 100, max_drawdown: 5 })),
      { total_return: 100, max_drawdown: 12 }, // breaches
    ];
    const r = walkForwardCheck(makeWfSummary({ windows }), 10_000, 60);
    expect(r.severity).toBe("fail");
    expect(r.reason).toContain("breaches FTMO 10% limit");
  });

  it("worst window DD within 2pp of FTMO limit (≥8 <10) → caution", () => {
    const windows = [
      ...Array.from({ length: 9 }, () => ({ total_return: 100, max_drawdown: 5 })),
      { total_return: 100, max_drawdown: 9 },
    ];
    const r = walkForwardCheck(makeWfSummary({ windows }), 10_000, 60);
    expect(r.severity).toBe("caution");
    expect(r.reason).toContain("within 2pp of FTMO");
  });
});

describe("pairQualityCheck", () => {
  it("any loser (≥8 trades + WR ≤30%) → fail", () => {
    const stats: PairStat[] = [
      { ticker: "GBP/JPY", trades: 8, wins: 1, win_rate: 0.125, net_pnl: -500 },
    ];
    const r = pairQualityCheck(stats);
    expect(r.severity).toBe("fail");
    expect(r.reason).toContain("GBP/JPY 1/8");
  });

  it("no samples (or all under min_trades) → caution", () => {
    const stats: PairStat[] = [
      { ticker: "EUR/USD", trades: 5, wins: 2, win_rate: 0.4, net_pnl: 50 },
    ];
    const r = pairQualityCheck(stats);
    expect(r.severity).toBe("caution");
    expect(r.reason).toContain("Insufficient live trade history");
  });

  it("empty stats → caution", () => {
    expect(pairQualityCheck([]).severity).toBe("caution");
  });

  it("all pairs above WR floor → pass", () => {
    const stats: PairStat[] = [
      { ticker: "EUR/USD", trades: 10, wins: 5, win_rate: 0.5, net_pnl: 100 },
    ];
    expect(pairQualityCheck(stats).severity).toBe("pass");
  });
});

describe("sideSymmetryCheck", () => {
  it("side='auto' → caution", () => {
    const r = sideSymmetryCheck("auto");
    expect(r.severity).toBe("caution");
    expect(r.reason).toContain("verify shorts work");
  });

  it("side='long' → pass", () => {
    expect(sideSymmetryCheck("long").severity).toBe("pass");
  });

  it("undefined → pass with default 'long'", () => {
    expect(sideSymmetryCheck(undefined).severity).toBe("pass");
  });
});

describe("ftmoFitCheck", () => {
  const baseRules = {
    position_sizing: { type: "risk_per_trade", value: 1 },
    prop_firm: { consecutive_loss_daily_halt: 3 },
  } as unknown as AlgorithmRules;

  it("risk_per_trade > 1% → caution", () => {
    const r = ftmoFitCheck({
      position_sizing: { type: "risk_per_trade", value: 1.5 },
      prop_firm: { consecutive_loss_daily_halt: 3 },
    } as unknown as AlgorithmRules);
    expect(r.severity).toBe("caution");
    expect(r.reason).toContain("above 1%");
  });

  it("consecutive_loss_daily_halt = 0 → caution", () => {
    const r = ftmoFitCheck({
      position_sizing: { type: "risk_per_trade", value: 1 },
      prop_firm: { consecutive_loss_daily_halt: 0 },
    } as unknown as AlgorithmRules);
    expect(r.severity).toBe("caution");
    expect(r.reason).toContain("no consecutive_loss_daily_halt");
  });

  it("both ok → pass", () => {
    expect(ftmoFitCheck(baseRules).severity).toBe("pass");
  });
});
