/**
 * FTMO's XAU/USD facts as read by the operator (2026-11-18) and the clock tests.
 *  - Swap: long -58.41 points ($0.5841 an ounce a night at a bid/ask of 3,752.87 / 3,753.26).
 *  - Session: Monday to Friday 01:05 to 23:50 platform time.
 *  - Platform clock: +3 in US summer time, +2 otherwise, read from FTMO's notices and confirmed
 *    against FTMO fills in this repo (review/log.md, 2026-11-25). The other clocks are kept for comparison.
 */
export type Clock = "us" | "fixed2" | "eu";

const PLATFORM_OPEN_MIN = 65;
const PLATFORM_CLOSE_MIN = 23 * 60 + 50;
export const SWAP_LONG_USD_PER_OZ = 0.5841;
export const SWAP_QUOTE_PRICE = 3753.065;
/** The operator's reading, as a fraction of price per night. */
export const SWAP_FRACTION = SWAP_LONG_USD_PER_OZ / SWAP_QUOTE_PRICE;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

const zoneOffsetCache = new Map<string, number>();

/** Minutes east of UTC of `zone` at the instant `ms`. */
export function zoneOffsetMinutes(zone: string, ms: number): number {
  const key = zone + "|" + Math.floor(ms / HOUR_MS);
  const hit = zoneOffsetCache.get(key);
  if (hit !== undefined) {
    return hit;
  }
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  });
  const parts = new Map(fmt.formatToParts(new Date(ms)).map((p) => [p.type, Number(p.value)]));
  const local = Date.UTC(
    parts.get("year") ?? 0,
    (parts.get("month") ?? 1) - 1,
    parts.get("day") ?? 1,
    parts.get("hour") ?? 0,
    parts.get("minute") ?? 0,
    parts.get("second") ?? 0
  );
  const out = Math.round((local - ms) / 60_000);
  zoneOffsetCache.set(key, out);
  return out;
}

export function platformOffsetMinutes(ms: number, clock: Clock): number {
  if (clock === "fixed2") {
    return 120;
  }
  if (clock === "us") {
    return zoneOffsetMinutes("America/New_York", ms) + 7 * 60;
  }
  return zoneOffsetMinutes("Europe/Prague", ms) + 60;
}

/** Is FTMO's XAU/USD market closed at this instant? "nightly" = between two sessions of a trading week; "weekend" = Friday's close to Monday's open. */
export function closedKind(ms: number, clock: Clock): "open" | "nightly" | "weekend" {
  const local = new Date(ms + platformOffsetMinutes(ms, clock) * 60_000);
  const minute = local.getUTCHours() * 60 + local.getUTCMinutes();
  const dow = local.getUTCDay();
  if (dow >= 1 && dow <= 5 && minute >= PLATFORM_OPEN_MIN && minute < PLATFORM_CLOSE_MIN) {
    return "open";
  }
  if (dow === 6 || dow === 0 || (dow === 5 && minute >= PLATFORM_CLOSE_MIN) || (dow === 1 && minute < PLATFORM_OPEN_MIN)) {
    return "weekend";
  }
  return "nightly";
}

/** 17:00 New York on the UTC calendar day `day`. */
function rolloverInstant(dayMs: number): number {
  const guess = dayMs + 17 * HOUR_MS;
  return guess - zoneOffsetMinutes("America/New_York", guess) * 60_000;
}

/** The 17:00 New York rollovers strictly after `fromMs` and at or before `toMs`, Monday to Friday, with their swap units (Wednesday = 3). */
export function rollovers(fromMs: number, toMs: number): Array<{ ms: number; units: number }> {
  const out: Array<{ ms: number; units: number }> = [];
  for (let d = Math.floor(fromMs / DAY_MS) * DAY_MS - DAY_MS; d <= toMs + DAY_MS; d += DAY_MS) {
    const ms = rolloverInstant(d);
    const weekday = new Date(d).getUTCDay();
    if (weekday === 0 || weekday === 6 || ms <= fromMs || ms > toMs) {
      continue;
    }
    out.push({ ms, units: weekday === 3 ? 3 : 1 });
  }
  return out;
}

export function nyLabel(ms: number): string {
  const local = new Date(ms + zoneOffsetMinutes("America/New_York", ms) * 60_000);
  return local.toISOString().slice(0, 16).replace("T", " ") + " NY";
}

export function seasonOf(ms: number): "summer" | "winter" {
  return zoneOffsetMinutes("America/New_York", ms) === -240 ? "summer" : "winter";
}
