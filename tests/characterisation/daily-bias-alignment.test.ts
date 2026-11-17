/**
 * Characterisation — which daily bar the daily_bias filter sees.
 *
 * Two alignment rules exist: `alignCompletedDailyIndex` (last bar whose UTC
 * date is strictly before the 4h bar's date — right for start-stamped bars,
 * what live uses) and `alignBarIndex` (last bar whose instant ≤ the 4h bar —
 * right for close-stamped session bars). The backtest sets
 * `higherTfCloseStamped` so the evaluator uses the second rule on session
 * dailies, but `condition-evaluator.ts` drops the flag before it reaches the
 * pattern evaluator, so the backtest's bias is one session staler than live
 * on the bars that open at the session close (audit A6; docs/DEBT.md D-02).
 */
import { describe, expect, it } from "vitest";
import { evaluateConditionsDetailed } from "@/lib/market-data/condition-evaluator";
import { alignBarIndex, alignCompletedDailyIndex } from "@/lib/market-data/resample";
import type { PriceBar } from "@/lib/market-data/types";
import { evaluatePatternCondition } from "@/lib/patterns";
import type { PatternCondition } from "@/types/algorithm";

const bar = (date: string, close: number): PriceBar => ({
  date,
  open: close,
  high: close,
  low: close,
  close,
  volume: 0,
});

/** 21 session dailies stamped at their CLOSE instant (21:00 UTC). The first
 *  20 close at 100; the 21st closes at 110, so the bias is bullish only when
 *  that latest session is included (110 > SMA20 = 100.5). */
const sessionDailies: PriceBar[] = Array.from({ length: 21 }, (_, i) =>
  bar(`2026-03-${String(i + 1).padStart(2, "0")}T21:00:00.000Z`, i === 20 ? 110 : 100)
);
/** The 4h bar that opens at the instant the 21st session closes. */
const fourHourBar = bar("2026-03-21T21:00:00.000Z", 110);
const dailyBias: PatternCondition = {
  type: "pattern",
  pattern: "daily_bias",
  direction: "bullish",
  ma_period: 20,
  timeframe: "1d",
};

describe("the two alignment rules", () => {
  it("alignBarIndex includes a session that closed at the same instant", () => {
    expect(alignBarIndex(sessionDailies, fourHourBar.date)).toBe(20);
  });

  it("alignCompletedDailyIndex excludes every bar dated today, so it is one session behind here", () => {
    expect(alignCompletedDailyIndex(sessionDailies, fourHourBar.date)).toBe(19);
  });
});

describe("evaluatePatternCondition honours the flag when it receives it", () => {
  it("close-stamped → bullish (latest session included)", () => {
    expect(
      evaluatePatternCondition(dailyBias, [fourHourBar], 0, sessionDailies, undefined, {
        higherTfCloseStamped: true,
      })
    ).toBe(true);
  });

  it("start-stamped rule → not bullish (latest session excluded)", () => {
    expect(evaluatePatternCondition(dailyBias, [fourHourBar], 0, sessionDailies)).toBe(false);
  });
});

describe("evaluateConditionsDetailed drops the flag on the way", () => {
  const ctx = {
    cache: new Map(),
    closes: [fourHourBar.close],
    bars: [fourHourBar],
    i: 0,
    higherTfBars: sessionDailies,
    higherTfCloseStamped: true,
  };
  const noTechnical = () => false;

  it("current behaviour: the condition does not fire although the flag was set", () => {
    expect(evaluateConditionsDetailed([dailyBias], ctx, noTechnical)).toEqual({
      met: 0,
      total: 1,
      fired: [false],
    });
  });

  it.fails("intended: the flag reaches the pattern evaluator (audit A6, DEBT D-02)", () => {
    expect(evaluateConditionsDetailed([dailyBias], ctx, noTechnical).fired).toEqual([true]);
  });
});
