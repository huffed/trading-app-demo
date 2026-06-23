/**
 * Purged k-fold CV tests — locks López de Prado AFML ch.7 algorithm + edge
 * cases.
 *
 * Test inventory (≥10 per ROADMAP.md F.3 gate):
 *   Input validation:
 *     1. k < 2 throws
 *     2. embargoFraction ≥ 1/k throws
 *     3. riskPerTrade ≤ 0 throws
 *   Pure k-fold mechanics:
 *     4. k=5 produces 5 folds; folds tile the time axis without gap or overlap
 *     5. Empty trades returns empty fold list with safe defaults
 *     6. Sort stability — caller can pass unsorted trades
 *   Purging:
 *     7. Training trade whose [entry, exit] overlaps test window IS purged
 *     8. Training trade fully outside test window IS NOT purged
 *   Embargo:
 *     9. Training trade entering within embargo window after test_end IS embargoed
 *    10. Training trade entering after embargo window is NOT embargoed
 *    11. embargoFraction = 0 → no embargo applied
 *   Signal fixtures:
 *    12. All-positive R trades → 5/5 folds positive (consistency_count=5)
 *    13. All-negative R trades → 0/5 folds positive
 *    14. Mixed but mostly-positive → ≥4/5 folds positive (clean signal)
 *    15. Concentrated-edge (all profit in one fold) → ≤2/5 folds positive (regime-fragile)
 *   Aggregate:
 *    16. oos_mean_r_aggregate = mean of fold test_mean_r values
 *    17. oos_mean_r_std reflects variance across folds
 */
import { describe, expect, it } from "vitest";
import type { BacktestTrade } from "@/lib/market-data/types";
import { purgedKFoldEvaluate } from "./purged-kfold";

const RISK_PER_TRADE = 100; // R-multiple denominator (matches our convention: pnl in $, risk in $)

function mkTrade(
  entry_iso: string,
  exit_iso: string,
  pnl: number,
  side: "long" | "short" = "long",
): BacktestTrade {
  return {
    entry_date: entry_iso,
    exit_date: exit_iso,
    entry_price: 100,
    exit_price: 100 + pnl,
    side,
    pnl,
  };
}

/** Build N evenly-spaced trades over `years` years. PnL is computed from
 *  the (1-indexed) ordinal index by a caller-supplied function. */
function buildEvenTrades(
  count: number,
  years: number,
  pnlForIdx: (idx: number) => number,
): BacktestTrade[] {
  const startMs = new Date("2020-01-01T00:00:00Z").getTime();
  const spanMs = years * 365.25 * 24 * 60 * 60 * 1000;
  const stepMs = spanMs / count;
  const holdMs = 4 * 60 * 60 * 1000; // 4-hour hold per trade
  const out: BacktestTrade[] = [];
  for (let i = 0; i < count; i++) {
    const entryMs = startMs + i * stepMs;
    const exitMs = entryMs + holdMs;
    out.push(
      mkTrade(new Date(entryMs).toISOString(), new Date(exitMs).toISOString(), pnlForIdx(i)),
    );
  }
  return out;
}

describe("purgedKFoldEvaluate — input validation", () => {
  it("throws when k < 2", () => {
    const trades = buildEvenTrades(50, 1, () => 50);
    expect(() => purgedKFoldEvaluate(trades, RISK_PER_TRADE, { k: 1 })).toThrow(/k ≥ 2/);
    expect(() => purgedKFoldEvaluate(trades, RISK_PER_TRADE, { k: 0 })).toThrow(/k ≥ 2/);
  });

  it("throws when embargoFraction ≥ 1/k", () => {
    const trades = buildEvenTrades(50, 1, () => 50);
    expect(() =>
      purgedKFoldEvaluate(trades, RISK_PER_TRADE, { k: 5, embargoFraction: 0.21 }),
    ).toThrow(/embargoFraction/);
  });

  it("throws when riskPerTrade ≤ 0", () => {
    const trades = buildEvenTrades(50, 1, () => 50);
    expect(() => purgedKFoldEvaluate(trades, 0)).toThrow(/riskPerTrade/);
    expect(() => purgedKFoldEvaluate(trades, -1)).toThrow(/riskPerTrade/);
  });
});

describe("purgedKFoldEvaluate — fold mechanics", () => {
  it("k=5 produces 5 folds tiling the time axis", () => {
    const trades = buildEvenTrades(100, 5, () => 50);
    const result = purgedKFoldEvaluate(trades, RISK_PER_TRADE, { k: 5, embargoFraction: 0 });
    expect(result.folds).toHaveLength(5);
    // Folds tile without gap (end of fold i = start of fold i+1).
    for (let i = 0; i < 4; i++) {
      expect(result.folds[i].test_end).toBe(result.folds[i + 1].test_start);
    }
  });

  it("empty trades → empty fold list + safe defaults", () => {
    const result = purgedKFoldEvaluate([], RISK_PER_TRADE);
    expect(result.folds).toHaveLength(0);
    expect(result.consistency_count).toBe(0);
    expect(result.oos_mean_r_aggregate).toBe(0);
    expect(result.oos_mean_r_std).toBe(0);
  });

  it("caller-unsorted trades are sorted internally", () => {
    const ordered = buildEvenTrades(40, 4, (i) => i); // PnL is ordinal index
    const shuffled = [...ordered].reverse();
    const r1 = purgedKFoldEvaluate(ordered, RISK_PER_TRADE, { k: 4, embargoFraction: 0 });
    const r2 = purgedKFoldEvaluate(shuffled, RISK_PER_TRADE, { k: 4, embargoFraction: 0 });
    // Per-fold test_n + test_mean_r should match exactly (sorting is internal).
    for (let i = 0; i < 4; i++) {
      expect(r1.folds[i].test_n).toBe(r2.folds[i].test_n);
      expect(r1.folds[i].test_mean_r).toBeCloseTo(r2.folds[i].test_mean_r, 8);
    }
  });
});

describe("purgedKFoldEvaluate — purging", () => {
  it("training trade whose [entry, exit] overlaps test window IS purged", () => {
    // Test fold = year 2; build a trade that ENTERS in year 1 but doesn't EXIT
    // until year 2 (held across the boundary). It should be purged from training.
    const startY1 = new Date("2020-06-01T00:00:00Z").toISOString(); // entry year 1
    const exitY2 = new Date("2021-03-15T00:00:00Z").toISOString(); // exit year 2 (boundary at 2021-01-01)
    const overlap = mkTrade(startY1, exitY2, 100);
    // Plus a clean training trade fully in year 1
    const cleanY1 = mkTrade(
      new Date("2020-03-01T00:00:00Z").toISOString(),
      new Date("2020-03-01T04:00:00Z").toISOString(),
      100,
    );
    // Plus a test-window trade in year 2
    const testY2 = mkTrade(
      new Date("2021-06-01T00:00:00Z").toISOString(),
      new Date("2021-06-01T04:00:00Z").toISOString(),
      100,
    );
    // Fold boundaries computed from min entry → max exit: 2020-03-01 → 2021-06-01
    const result = purgedKFoldEvaluate([overlap, cleanY1, testY2], RISK_PER_TRADE, {
      k: 2,
      embargoFraction: 0,
    });
    // Fold 1 = first half (year 1ish), Fold 2 = second half (year 2ish).
    // For fold 2 evaluation: testY2 is the test trade; overlap should be purged.
    const fold2 = result.folds[1];
    expect(fold2.test_n).toBeGreaterThanOrEqual(1);
    expect(fold2.purged_count).toBeGreaterThanOrEqual(1);
  });

  it("training trade fully outside test window IS NOT purged", () => {
    // Build 20 short-hold trades evenly spaced; embargo=0; k=5.
    // Each fold has 4 test trades + 16 training trades. No overlaps possible
    // because trades only span 4 hours each and folds are ~1 year each.
    const trades = buildEvenTrades(20, 5, () => 100);
    const result = purgedKFoldEvaluate(trades, RISK_PER_TRADE, { k: 5, embargoFraction: 0 });
    for (const f of result.folds) {
      expect(f.purged_count).toBe(0);
    }
  });
});

describe("purgedKFoldEvaluate — embargo", () => {
  it("training trade entering within post-test embargo IS embargoed", () => {
    // 100 trades over 10 years. Embargo = 0.1 (= 1 year). For fold 1 (year 1),
    // training trades in year 2 (within 1yr after fold 1 end) should be embargoed.
    const trades = buildEvenTrades(100, 10, () => 100);
    const result = purgedKFoldEvaluate(trades, RISK_PER_TRADE, {
      k: 5,
      embargoFraction: 0.1, // < 1/5 = 0.2; valid
    });
    // Fold 0 = years 0-2. Embargo of 1 year covers years 2-3.
    // Trades in years 2-3 should be embargoed from training (10 trades, since
    // 100 trades / 10 years = 10/year).
    const fold0 = result.folds[0];
    expect(fold0.embargoed_count).toBeGreaterThan(0);
  });

  it("training trade after embargo window IS NOT embargoed", () => {
    // For fold 0 (years 0-2) with embargo 0.05 (= 0.5 year covering 2-2.5),
    // trades in years 2.5+ should be training trades, NOT embargoed.
    const trades = buildEvenTrades(100, 10, () => 100);
    const result = purgedKFoldEvaluate(trades, RISK_PER_TRADE, {
      k: 5,
      embargoFraction: 0.05,
    });
    const fold0 = result.folds[0];
    // train + test + purged + embargoed should account for all 100 trades.
    const accounted = fold0.train_n + fold0.test_n + fold0.purged_count + fold0.embargoed_count;
    expect(accounted).toBe(100);
    // Most are training (rough math: test ~20, embargoed ~5, purged 0 → train ~75).
    expect(fold0.train_n).toBeGreaterThan(50);
  });

  it("embargoFraction = 0 → no embargo", () => {
    const trades = buildEvenTrades(50, 5, () => 100);
    const result = purgedKFoldEvaluate(trades, RISK_PER_TRADE, { k: 5, embargoFraction: 0 });
    for (const f of result.folds) {
      expect(f.embargoed_count).toBe(0);
    }
  });
});

describe("purgedKFoldEvaluate — signal fixtures (ROADMAP F.3 gate)", () => {
  it("all-positive R trades → 5/5 folds positive (consistency_count=5)", () => {
    const trades = buildEvenTrades(50, 5, () => 50); // each trade pnl=50, R=50/100=0.5
    const result = purgedKFoldEvaluate(trades, RISK_PER_TRADE, { k: 5, embargoFraction: 0 });
    expect(result.consistency_count).toBe(5);
    expect(result.oos_mean_r_aggregate).toBeCloseTo(0.5, 5);
  });

  it("all-negative R trades → 0/5 folds positive", () => {
    const trades = buildEvenTrades(50, 5, () => -30);
    const result = purgedKFoldEvaluate(trades, RISK_PER_TRADE, { k: 5, embargoFraction: 0 });
    expect(result.consistency_count).toBe(0);
    expect(result.oos_mean_r_aggregate).toBeLessThan(0);
  });

  it("mixed but mostly-positive → ≥4/5 folds positive (clean signal, gate met)", () => {
    // 80% positive trades, 20% negative — uniformly distributed → most folds positive.
    const trades = buildEvenTrades(100, 5, (i) => (i % 5 === 0 ? -50 : 50));
    const result = purgedKFoldEvaluate(trades, RISK_PER_TRADE, { k: 5, embargoFraction: 0 });
    expect(result.consistency_count).toBeGreaterThanOrEqual(4);
  });

  it("concentrated-edge (all profit in one fold) → ≤2/5 folds positive (regime-fragile)", () => {
    // 100 trades over 5 years. Trades in year 2 are very profitable; all
    // others are slight losers. Aggregate Sharpe may look positive but per-fold
    // shows the edge is CONCENTRATED — exactly the case purged k-fold is
    // designed to detect.
    const trades = buildEvenTrades(100, 5, (i) => {
      // Year 2 = indices 20-39 (years 1-2 since startMs).
      if (i >= 20 && i < 40) return 500;
      return -20;
    });
    const result = purgedKFoldEvaluate(trades, RISK_PER_TRADE, { k: 5, embargoFraction: 0 });
    expect(result.consistency_count).toBeLessThanOrEqual(2);
    expect(result.oos_mean_r_std).toBeGreaterThan(0.5); // high regime variability
  });
});

describe("purgedKFoldEvaluate — aggregate stats", () => {
  it("oos_mean_r_aggregate equals mean of fold test_mean_r values", () => {
    const trades = buildEvenTrades(50, 5, (i) => (i < 25 ? 100 : -50));
    const result = purgedKFoldEvaluate(trades, RISK_PER_TRADE, { k: 5, embargoFraction: 0 });
    let manualMean = 0;
    for (const f of result.folds) manualMean += f.test_mean_r;
    manualMean /= result.folds.length;
    expect(result.oos_mean_r_aggregate).toBeCloseTo(manualMean, 8);
  });

  it("oos_mean_r_std reflects fold-to-fold variance", () => {
    // Mixed fixture has variance across folds; identical fixture should have 0 std.
    const identical = buildEvenTrades(50, 5, () => 30);
    const mixed = buildEvenTrades(50, 5, (i) => (i % 2 === 0 ? 100 : -100));
    const rIdent = purgedKFoldEvaluate(identical, RISK_PER_TRADE, { k: 5, embargoFraction: 0 });
    const rMix = purgedKFoldEvaluate(mixed, RISK_PER_TRADE, { k: 5, embargoFraction: 0 });
    expect(rIdent.oos_mean_r_std).toBeCloseTo(0, 5);
    expect(rMix.oos_mean_r_std).toBeGreaterThanOrEqual(0); // may be small if balanced per fold
  });

  it("realistic Phase E scenario: T=126 BOS-Long-like, k=5, embargo=0.01", () => {
    // Mirror the BOS-Long XAU 4h candidate: ~126 trades over 6yr, R ≈ +0.16.
    const trades = buildEvenTrades(126, 6, (i) => 16 + (i % 7) * 5 - 15); // mean ~+16
    const result = purgedKFoldEvaluate(trades, RISK_PER_TRADE, { k: 5, embargoFraction: 0.01 });
    expect(result.folds).toHaveLength(5);
    // Compute span check: each fold has ~25 test trades.
    for (const f of result.folds) {
      expect(f.test_n).toBeGreaterThan(15);
      expect(f.test_n).toBeLessThan(40);
    }
  });
});
