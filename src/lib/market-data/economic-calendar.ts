/**
 * Economic calendar — wraps Finnhub's /calendar/economic endpoint.
 *
 * The "news veto" pattern (block trade entries inside a window around
 * high-impact releases) is the highest-EV use of news data for a system
 * that isn't a true news scalper, per public-strategy research.
 *
 * Free Finnhub tier: 60 req/min. We cache aggressively because the calendar
 * for a given date range is essentially static.
 */

const BASE_URL = "https://finnhub.io/api/v1";

export type EventImpact = "low" | "medium" | "high";

export interface EconomicEvent {
  /** ISO timestamp of the release (UTC). */
  time: string;
  /** Currency the release affects (USD, EUR, GBP, JPY, ...). */
  currency: string;
  /** Headline / event name (e.g. "Federal Funds Rate"). */
  event: string;
  impact: EventImpact;
}

interface FinnhubEvent {
  country?: string;
  event?: string;
  time?: string;
  impact?: string;
  actual?: string | number | null;
  estimate?: string | number | null;
  prev?: string | number | null;
}

interface FinnhubCalendarResponse {
  economicCalendar?: FinnhubEvent[];
}

const COUNTRY_TO_CURRENCY: Record<string, string> = {
  US: "USD",
  EU: "EUR",
  DE: "EUR",
  FR: "EUR",
  IT: "EUR",
  ES: "EUR",
  GB: "GBP",
  UK: "GBP",
  JP: "JPY",
  CH: "CHF",
  AU: "AUD",
  CA: "CAD",
  NZ: "NZD",
  CN: "CNY",
};

const FIAT = new Set(Object.values(COUNTRY_TO_CURRENCY));

/**
 * Map a tradeable symbol to the fiat currencies whose news affects it.
 * - Forex pairs: split on "/" and keep recognised fiats.
 * - Spot metals (XAU/USD, XAG/USD) and energy (USOIL, UKOIL, NATGAS) react
 *   primarily to USD news.
 */
export function getEventCurrencies(symbol: string): string[] {
  const upper = symbol.toUpperCase();
  if (upper.includes("/")) {
    const parts = upper.split("/").filter((p) => FIAT.has(p));
    if (parts.length > 0) return parts;
    // Metals like XAU/USD whose first leg isn't fiat — fall through to USD.
  }
  if (
    upper.startsWith("XAU") ||
    upper.startsWith("XAG") ||
    upper === "USOIL" ||
    upper === "UKOIL" ||
    upper === "NATGAS"
  ) {
    return ["USD"];
  }
  return [];
}

const IMPACT_RANK: Record<EventImpact, number> = { low: 1, medium: 2, high: 3 };

function normaliseImpact(raw: string | undefined): EventImpact {
  const v = (raw ?? "").toLowerCase();
  if (v.startsWith("h")) return "high";
  if (v.startsWith("m")) return "medium";
  return "low";
}

function parseEvent(e: FinnhubEvent): EconomicEvent | null {
  if (!e.time || !e.country || !e.event) return null;
  const currency = COUNTRY_TO_CURRENCY[e.country.toUpperCase()];
  if (!currency) return null;
  // Finnhub returns "YYYY-MM-DD HH:mm:ss" in UTC. Normalise to ISO.
  const iso = e.time.includes("T") ? e.time : `${e.time.replace(" ", "T")}Z`;
  return {
    time: iso,
    currency,
    event: e.event,
    impact: normaliseImpact(e.impact),
  };
}

const CACHE_TTL_MS = 60 * 60 * 1000;
const memoryCache = new Map<string, { data: EconomicEvent[]; fetchedAt: number }>();

function dateOnly(d: Date): string {
  return d.toISOString().split("T")[0];
}

/**
 * Fetch economic calendar events between two dates (inclusive).
 * Returns [] on any failure — the calendar is non-critical for trade
 * execution; we'd rather miss a veto than block the whole entry pipeline.
 */
export async function fetchEconomicCalendar(from: Date, to: Date): Promise<EconomicEvent[]> {
  const fromStr = dateOnly(from);
  const toStr = dateOnly(to);
  const cacheKey = `${fromStr}:${toStr}`;
  const cached = memoryCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.data;
  }

  const apiKey = process.env.FINNHUB_API_KEY;
  if (!apiKey) {
    console.warn("[economic-calendar] FINNHUB_API_KEY missing — news veto will not fire");
    return [];
  }

  try {
    const url = `${BASE_URL}/calendar/economic?from=${fromStr}&to=${toStr}&token=${apiKey}`;
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`[economic-calendar] Finnhub returned ${res.status}`);
      return [];
    }
    const data = (await res.json()) as FinnhubCalendarResponse;
    const events = (data.economicCalendar ?? [])
      .map(parseEvent)
      .filter((e): e is EconomicEvent => e !== null);
    memoryCache.set(cacheKey, { data: events, fetchedAt: Date.now() });
    return events;
  } catch (err) {
    console.warn(
      "[economic-calendar] fetch failed:",
      err instanceof Error ? err.message : err
    );
    return [];
  }
}

/**
 * Returns true if `now` falls inside a veto window of any matching event.
 * - currencies: fiat codes whose events should block (e.g. ["EUR", "USD"])
 * - beforeMinutes: window before release
 * - afterMinutes: window after release
 * - minImpact: filter out events below this impact (default "high")
 */
export function isWithinVetoWindow(
  now: Date,
  events: EconomicEvent[],
  currencies: string[],
  beforeMinutes: number,
  afterMinutes: number,
  minImpact: EventImpact = "high"
): EconomicEvent | null {
  if (currencies.length === 0) return null;
  const minRank = IMPACT_RANK[minImpact];
  const nowMs = now.getTime();
  const beforeMs = beforeMinutes * 60 * 1000;
  const afterMs = afterMinutes * 60 * 1000;

  for (const e of events) {
    if (IMPACT_RANK[e.impact] < minRank) continue;
    if (!currencies.includes(e.currency)) continue;
    const eventMs = new Date(e.time).getTime();
    if (Number.isNaN(eventMs)) continue;
    // Inside window: now ∈ [event - before, event + after]
    if (nowMs >= eventMs - beforeMs && nowMs <= eventMs + afterMs) {
      return e;
    }
  }
  return null;
}

/**
 * Build a per-bar veto checker for the backtest engine. Returns null when
 * the algorithm has no veto, no symbol context, or no events available —
 * the caller can short-circuit.
 */
export function buildVetoCheck(args: {
  symbol?: string;
  events?: EconomicEvent[];
  veto: { block_minutes_before: number; block_minutes_after: number; min_impact: EventImpact };
}): ((barDate: string) => boolean) | null {
  if (!args.symbol || !args.events?.length) return null;
  const currencies = getEventCurrencies(args.symbol);
  if (currencies.length === 0) return null;
  const events = args.events;
  const v = args.veto;
  return (barDate) => {
    const t = new Date(barDate);
    if (Number.isNaN(t.getTime())) return false;
    return (
      isWithinVetoWindow(
        t,
        events,
        currencies,
        v.block_minutes_before,
        v.block_minutes_after,
        v.min_impact
      ) !== null
    );
  };
}
