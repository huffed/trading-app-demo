/**
 * OANDA REST v20 candles fetcher — drop-in replacement for the
 * `fetchDailyPrices` interface in twelve-data.ts.
 *
 * Why this exists: Twelve Data's 800 credit/day free tier was the
 * primary live price source historically, but in practice it lags
 * and rate-limits on intraday refreshes — the 2026-05-12 incident
 * (cache stuck for ~60 min, every 15m/30m scan refused by the
 * bar-staleness gate) showed Twelve Data missing publishes even
 * when credits weren't exhausted. OANDA, used for historical
 * backfill since 2026-05-06 with zero issues, has practically
 * unlimited rate for a funded practice account and serves the
 * same OHLC mid-price data.
 *
 * Promoted to head of the fallback chain in prices.ts. Twelve Data
 * stays as fallback for redundancy.
 *
 * Auth: `OANDA_API_KEY` env var (the practice token — same one
 * scripts/oanda-backfill.ts uses). No new secret required.
 *
 * Endpoint: practice (`api-fxpractice.oanda.com`). Practice and
 * live serve identical OHLC for the instruments we care about;
 * practice has no rate-limit anxiety; the operator's existing
 * token is practice-scoped.
 */
import type { BarInterval } from "./interval";
import type { PriceBar } from "./types";

const BASE_URL = "https://api-fxpractice.oanda.com";

/** App-style symbol (e.g. "XAU/USD") → OANDA instrument code (e.g. "XAU_USD"). */
function toOandaInstrument(symbol: string): string {
  return symbol.replace("/", "_").toUpperCase();
}

/** BarInterval → OANDA granularity code. */
function toOandaGranularity(interval: BarInterval): string {
  switch (interval) {
    case "15min":
      return "M15";
    case "30min":
      return "M30";
    case "1h":
      return "H1";
    case "4h":
      return "H4";
    case "1day":
      return "D";
  }
}

interface OandaMid {
  o: string;
  h: string;
  l: string;
  c: string;
}

interface OandaCandle {
  time: string;
  volume: number;
  complete: boolean;
  mid: OandaMid;
}

interface OandaCandlesResponse {
  instrument?: string;
  granularity?: string;
  candles?: OandaCandle[];
  errorMessage?: string;
}

/**
 * Convert an OANDA candle to our internal PriceBar shape. Mirrors the
 * date format Twelve Data uses (space-separated YYYY-MM-DD HH:MM:SS)
 * so price_cache merge-by-date stays consistent across providers and
 * the existing 28K-bar OANDA backfill.
 */
function oandaToBar(c: OandaCandle): PriceBar {
  return {
    date: c.time.slice(0, 19).replace("T", " "),
    open: parseFloat(c.mid.o),
    high: parseFloat(c.mid.h),
    low: parseFloat(c.mid.l),
    close: parseFloat(c.mid.c),
    volume: c.volume,
  };
}

export async function fetchDailyPrices(
  symbol: string,
  outputSize: "compact" | "full" = "compact",
  interval: BarInterval = "1day"
): Promise<PriceBar[]> {
  const token = process.env.OANDA_API_KEY;
  if (!token) throw new Error("OANDA_API_KEY is not set");

  const instrument = toOandaInstrument(symbol);
  const granularity = toOandaGranularity(interval);
  const count = outputSize === "full" ? 5000 : 100;

  // price=M → mid-price candles (matches Twelve Data's quote model).
  // smooth=false (default) gives raw OHLC, same as backfill.
  const url = `${BASE_URL}/v3/instruments/${instrument}/candles?granularity=${granularity}&count=${count}&price=M`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`OANDA request failed: ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as OandaCandlesResponse;
  if (data.errorMessage) {
    throw new Error(`OANDA error: ${data.errorMessage}`);
  }
  if (!data.candles || data.candles.length === 0) {
    throw new Error(`No price data returned from OANDA for ${instrument}`);
  }

  // Skip the currently-forming bar (`complete: false`). For live scans
  // we want the most recent CLOSED bar — a partial bar has unstable
  // OHLC that drifts between scans and would feed the LLM noise.
  // Matches the backfill script's behaviour and what consumers expect
  // from the existing Twelve Data path (Twelve Data only serves closed
  // bars in time_series, so skipping incomplete here keeps callers
  // provider-agnostic).
  return data.candles
    .filter((c) => c.complete)
    .map(oandaToBar)
    .sort((a, b) => a.date.localeCompare(b.date));
}
