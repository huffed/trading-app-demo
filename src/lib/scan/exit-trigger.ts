/**
 * Exit-trigger evaluation — pure function that decides whether an open
 * position should close on the current tick.
 *
 * Extracted from scan/engine.ts on 2026-06-22 (CB.H1 + CB.T1 hybrid pass)
 * so the exit-trigger logic can be unit-tested independently of the
 * scan/manage orchestrators. The behaviour is byte-equivalent to the
 * pre-extraction inline implementation (verified by check-out diff).
 *
 * Checks in priority order:
 *   1. Stop-loss hit (price-vs-SL comparison, sign by side)
 *   2. Take-profit hit (mirrored comparison)
 *   3. Technical + pattern exit conditions evaluated via the shared
 *      condition module (`@/lib/conditions/evaluate`) so live + backtest
 *      use identical evaluation semantics
 *
 * Sentiment exit conditions are handled by the live-signal pipeline
 * (NOT here) — both because sentiment requires async API fetches and
 * because backtest can't see real-time news. Returns null when nothing
 * triggers.
 */
import { checkConditions, normalize, type Cache } from "@/lib/conditions/evaluate";
import { resampleToDaily } from "@/lib/market-data/resample";
import type { PriceBar } from "@/lib/market-data/types";
import {
  isPatternCondition,
  isTechnicalCondition,
  type AlgorithmRules,
  type PatternCondition,
  type TechnicalCondition,
} from "@/types/algorithm";
import type { PaperPosition } from "@/types/position";

/**
 * Evaluate whether an open position should close on the current tick.
 *
 * @returns The exit reason string ("stop_loss", "take_profit",
 *   "exit_signal") OR null if no trigger fires.
 *
 * Priority: SL hit > TP hit > condition-based exit. SL/TP are checked
 * first so an intra-bar SL hit isn't masked by a satisfied exit
 * condition (analytics need the truthful exit_reason).
 */
export function checkExitTrigger(
  position: PaperPosition,
  currentPrice: number,
  rules: AlgorithmRules,
  bars: PriceBar[],
  closes: number[],
  dailyBars: PriceBar[] | null
): string | null {
  const isLong = position.side === "long";

  // Stop loss
  if (position.stop_loss_price != null) {
    const slHit = isLong
      ? currentPrice <= position.stop_loss_price
      : currentPrice >= position.stop_loss_price;
    if (slHit) {
      return "stop_loss";
    }
  }

  // Take profit
  if (position.take_profit_price != null) {
    const tpHit = isLong
      ? currentPrice >= position.take_profit_price
      : currentPrice <= position.take_profit_price;
    if (tpHit) {
      return "take_profit";
    }
  }

  // Technical + pattern exit conditions (sentiment exits are evaluated
  // separately via the live signal pipeline; not handled here).
  const normalizedExit = normalize(rules.exit_conditions);
  const evaluableExit = normalizedExit.filter(
    (c) => isTechnicalCondition(c) || isPatternCondition(c)
  ) as Array<TechnicalCondition | PatternCondition>;
  if (evaluableExit.length > 0) {
    const cache: Cache = new Map();
    if (
      checkConditions(
        evaluableExit,
        {
          cache,
          closes,
          bars,
          i: closes.length - 1,
          higherTfBars: dailyBars ?? resampleToDaily(bars),
        },
        rules.exit_logic ?? rules.entry_logic
      )
    ) {
      return "exit_signal";
    }
  }

  return null;
}
