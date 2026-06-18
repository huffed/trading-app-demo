import type { BacktestTrade } from "./types";

/** B.1.5 fix: `BacktestTrade.side` is required by the type. Pre-fix
 *  validate-algo had `side: t.side ?? "long"` which silently labelled
 *  SHORT trades as LONG when the engine had a side-population bug,
 *  masking the bug in direction-conflict sibling matching.
 *
 *  This helper enforces the type at runtime — throws with a descriptive
 *  message naming the offending algo + the raw side value. Validator
 *  calls this before adding trades to the sibling pool. */
export function assertTradeSidePopulated(trade: BacktestTrade, algoName: string): void {
  if (trade.side !== "long" && trade.side !== "short") {
    throw new Error(
      `validate-algo: algo "${algoName}" produced trade without valid side (got ${JSON.stringify(trade.side)}). Engine side-population bug — fix before continuing.`
    );
  }
}
