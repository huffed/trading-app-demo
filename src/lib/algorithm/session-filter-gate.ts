/**
 * Static session-window entry gate (2026-10 spec §7 / E2.31 finding 4).
 *
 * History matters here: a clock-time session filter existed once and was
 * DELETED for baking one hardcoded UTC window into the engine (the ATR
 * liquidity gate replaced it as the adaptive default). This gate is the
 * disciplined return of the idea: the window is a PER-ALGO RULE
 * (`rules.session_filter`), populated only by the search enumerator's
 * pre-registered session axis — never a global constant. Absent field =
 * gate entirely inert, so every deployed algo is unaffected.
 *
 * Semantics (pre-registered in algo-search-2026-10.spec.md §2):
 *  - Hour source: the SIGNAL BAR'S OPEN hour, UTC (`bars[last].date` in
 *    the live ladder; `bars[i].date` in backtest) — identical in both
 *    paths, deterministic, DST-free by construction.
 *  - Window: inclusive start, exclusive end ([start, end) — matches the
 *    SESSION_WINDOWS convention in gold-session-window.ts).
 *  - Wrap-around supported (start > end, e.g. 22→04 spans midnight).
 *  - start === end is degenerate → treated as disabled (pass-through).
 */
import { parseBarDate } from "@/lib/market-data/parse-bar-date";

export interface SessionFilterConfig {
  /** Window start, UTC hour 0-23 (inclusive). */
  start_hour_utc: number;
  /** Window end, UTC hour 0-23 (exclusive). */
  end_hour_utc: number;
}

export interface SessionFilterResult {
  block: boolean;
  status: "ok" | "outside_window" | "disabled";
  hour_utc: number | null;
  window: string;
  reason?: string;
}

export function checkSessionFilter(args: {
  config: SessionFilterConfig | null | undefined;
  /** The signal bar's `date` (open timestamp). */
  barDate: string | Date | null | undefined;
}): SessionFilterResult {
  const cfg = args.config;
  if (!cfg || cfg.start_hour_utc === cfg.end_hour_utc) {
    return { block: false, status: "disabled", hour_utc: null, window: "—" };
  }
  const window = `${String(cfg.start_hour_utc).padStart(2, "0")}:00–${String(cfg.end_hour_utc).padStart(2, "0")}:00 UTC`;
  if (!args.barDate) {
    return { block: false, status: "disabled", hour_utc: null, window };
  }
  const d = parseBarDate(args.barDate);
  if (Number.isNaN(d.getTime())) {
    return { block: false, status: "disabled", hour_utc: null, window };
  }
  const hour = d.getUTCHours();
  const inWindow =
    cfg.start_hour_utc < cfg.end_hour_utc
      ? hour >= cfg.start_hour_utc && hour < cfg.end_hour_utc
      : hour >= cfg.start_hour_utc || hour < cfg.end_hour_utc; // wrap-around
  if (inWindow) {
    return { block: false, status: "ok", hour_utc: hour, window };
  }
  return {
    block: true,
    status: "outside_window",
    hour_utc: hour,
    window,
    reason: `Session filter: signal bar opened ${String(hour).padStart(2, "0")}:xx UTC, outside the ${window} entry window`,
  };
}
