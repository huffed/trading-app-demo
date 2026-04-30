/**
 * Post-news window detector — fires when the current bar's timestamp
 * falls within [min_minutes_after, max_minutes_after) AFTER a news event
 * matching the configured impact and currency filters.
 *
 * Distinct from the existing `lib/market-data/economic-calendar.ts` veto
 * window which BLOCKS trading 2 min ± news. This primitive is positive-
 * signal: it enables fade strategies that wait for the post-release
 * spike to settle and then enter on the reaction reversal.
 *
 * Why: research (brightfunded.com, fxnx.com — research dump 2026-04-30)
 * consistently shows the 5-30 min post-release window has predictable
 * spread/volatility decay with reversion edges on gold around NFP/FOMC/
 * CPI. Fading the reactionary spike with an engulfing reversal is a
 * high-conviction setup historically.
 *
 * Caller responsibility: news events are passed via the evaluator's
 * `context.news_events` parameter. Backtest engines populate this from
 * a historical news feed (cached Finnhub data); the live scan engine
 * pulls from the current economic-calendar fetch. When events is empty
 * or undefined, the detector returns `{ detected: false }` — it never
 * fires without explicit news context.
 *
 * Returns the matched event so downstream code can anchor SL/TP to the
 * spike's high/low if desired.
 */
import type { EconomicEvent, EventImpact } from "@/lib/market-data/economic-calendar";
import type { PriceBar } from "@/lib/market-data/types";
import type { PatternResult } from "./types";

export interface PostNewsWindowDetails {
  event_time: string;
  event_currency: string;
  event_name: string;
  event_impact: EventImpact;
  /** Minutes elapsed between the news release and the current bar. */
  minutes_since_event: number;
}

export interface PostNewsWindowOptions {
  /** Inclusive lower bound on minutes-after. Default 5. */
  min_minutes_after?: number;
  /** Exclusive upper bound on minutes-after. Default 30. */
  max_minutes_after?: number;
  /** Minimum impact level to react to. Default "high" — fade strategies
   *  should never fire on routine releases. */
  min_impact?: EventImpact;
  /** Currencies the news event must affect. Empty / undefined matches
   *  any currency (caller intentionally not filtering). Typically
   *  populated from `getEventCurrencies(symbol)`. */
  relevant_currencies?: string[];
  /** News events the detector can match against. Required — detector
   *  cannot fire without explicit context. */
  events: EconomicEvent[];
}

const DEFAULTS = {
  min_minutes_after: 5,
  max_minutes_after: 30,
  min_impact: "high" as EventImpact,
} as const;

const IMPACT_RANK: Record<EventImpact, number> = { low: 0, medium: 1, high: 2 };

export function detectPostNewsWindow(
  bars: PriceBar[],
  idx: number,
  options: PostNewsWindowOptions
): PatternResult<PostNewsWindowDetails> {
  const bar = bars[idx];
  if (!bar) return { detected: false };

  const events = options.events;
  if (!events || events.length === 0) return { detected: false };

  const minMin = options.min_minutes_after ?? DEFAULTS.min_minutes_after;
  const maxMin = options.max_minutes_after ?? DEFAULTS.max_minutes_after;
  const minImpact = options.min_impact ?? DEFAULTS.min_impact;
  const relevantCcys = options.relevant_currencies;

  const barTs = Date.parse(bar.date);
  if (Number.isNaN(barTs)) return { detected: false };

  for (const ev of events) {
    if (IMPACT_RANK[ev.impact] < IMPACT_RANK[minImpact]) continue;
    if (relevantCcys && relevantCcys.length > 0 && !relevantCcys.includes(ev.currency)) {
      continue;
    }
    const eventTs = Date.parse(ev.time);
    if (Number.isNaN(eventTs)) continue;
    const minutesSince = (barTs - eventTs) / 60000;
    if (minutesSince < minMin) continue;
    if (minutesSince >= maxMin) continue;
    return {
      detected: true,
      details: {
        event_time: ev.time,
        event_currency: ev.currency,
        event_name: ev.event,
        event_impact: ev.impact,
        minutes_since_event: Number(minutesSince.toFixed(1)),
      },
    };
  }

  return { detected: false };
}
