/**
 * Session-time window detector — fires when the current bar's UTC hour
 * falls inside a named institutional session window. Gold-specific
 * primitive (scoped naming): the carve-out is justified by dual-run
 * validation (`lib/algorithm/dual-run-validator.ts`) producing measured
 * edge differential against the same template without the filter.
 *
 * Why gold-specifically: ICT and prop-firm research (FTMO published case
 * studies, innercircletrader.net, fxnx.com — research dump 2026-04-30)
 * consistently anchors profitable gold setups to specific institutional
 * flow windows. Forex pairs do not benefit from clock-time gating in
 * the same way (operator decision recorded in feedback_data_driven_gates).
 *
 *   ny_killzone   : NY morning institutional flow (most-documented edge)
 *   silver_bullet : tighter NY session for liquidity-sweep entries
 *   london_open   : London morning institutional flow
 *   asian_session : Asian session (used as range-marker, not entry trigger)
 *
 * UTC windows are bounded to capture institutional flow on both sides of
 * DST without DST-tracking complexity. Use the dual-run validator to
 * confirm the window adds edge before deploying any template that uses it.
 */
import type { PriceBar } from "@/lib/market-data/types";
import type { PatternResult } from "./types";

export type SessionWindowName =
  | "ny_killzone"
  | "silver_bullet"
  | "london_open"
  | "asian_session";

export interface SessionWindowDetails {
  session: SessionWindowName;
  /** UTC hour of the bar (0-23). */
  hour_utc: number;
  /** Always true when detected. Surfaced so the activity log can show
   *  WHY the bar was eligible. */
  in_window: true;
}

/**
 * UTC hour ranges per named session. Inclusive on start, exclusive on
 * end — matches typical "9 to 11" semantics.
 *
 *  - ny_killzone (UTC 11:00-15:00): covers EDT 7-11am (DST: UTC-4) and
 *    EST 6-10am (non-DST: UTC-5). 4-hour window catches both DST regimes.
 *  - silver_bullet (UTC 14:00-16:00): covers EDT 10-12pm and EST 9-11am.
 *    The narrower ICT "Silver Bullet" 10-11am NY entry window.
 *  - london_open (UTC 06:00-10:00): covers BST 7-11am (DST: UTC+1) and
 *    GMT 6-10am (non-DST: UTC+0).
 *  - asian_session (UTC 00:00-07:00): standard Asian range definition
 *    window — bars are stamped UTC regardless of JST.
 */
export const SESSION_WINDOWS: Record<
  SessionWindowName,
  { start_utc: number; end_utc: number }
> = {
  ny_killzone: { start_utc: 11, end_utc: 15 },
  silver_bullet: { start_utc: 14, end_utc: 16 },
  london_open: { start_utc: 6, end_utc: 10 },
  asian_session: { start_utc: 0, end_utc: 7 },
};

export const SESSION_WINDOW_NAMES: SessionWindowName[] = [
  "ny_killzone",
  "silver_bullet",
  "london_open",
  "asian_session",
];

export interface SessionWindowOptions {
  session: SessionWindowName;
}

export function detectSessionWindow(
  bars: PriceBar[],
  idx: number,
  options: SessionWindowOptions
): PatternResult<SessionWindowDetails> {
  const window = SESSION_WINDOWS[options.session];
  if (!window) return { detected: false };
  const bar = bars[idx];
  if (!bar) return { detected: false };

  const ts = Date.parse(bar.date);
  if (Number.isNaN(ts)) return { detected: false };
  const hour = new Date(ts).getUTCHours();

  if (hour < window.start_utc || hour >= window.end_utc) return { detected: false };

  return {
    detected: true,
    details: {
      session: options.session,
      hour_utc: hour,
      in_window: true,
    },
  };
}
