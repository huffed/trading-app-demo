/**
 * OANDA positioning fetcher — wraps the v20 REST positionBook endpoint.
 *
 * Returns a snapshot of how OANDA's clients are currently positioned in
 * an instrument: aggregate long/short ratio plus a price-bucketed
 * distribution. Used as a crowd-sentiment / contrarian input to the
 * LLM-trader (e.g. "78% long is a contrarian-extreme reading").
 *
 * Host:
 *   OANDA_API_HOST defaults to api-fxpractice.oanda.com (practice).
 *   Practice positioning data is from demo accounts only — set the env
 *   var to api-fxtrade.oanda.com once we have a live account if we want
 *   real retail positioning rather than demo.
 *
 * Auth: Bearer OANDA_API_KEY (the same key used by scripts/oanda-backfill.ts).
 *
 * Aggregate math: per OANDA's spec, longCountPercent and
 * shortCountPercent are each "the percentage of the total number of
 * positions represented by long/short positions in this bucket". Summing
 * across buckets gives the total long% and short%, and the two should
 * sum to ~100. We store both the aggregates and the raw buckets so a
 * future analysis can drill into the distribution without re-fetching.
 */

export interface OandaPositioningBucket {
  price: number;
  long_count_percent: number;
  short_count_percent: number;
}

export interface OandaPositioningSnapshot {
  instrument: string;
  oanda_time: string;
  price: number;
  long_pct: number;
  short_pct: number;
  bucket_width: number;
  buckets: OandaPositioningBucket[];
}

interface RawBucket {
  price: string;
  longCountPercent: string;
  shortCountPercent: string;
}

interface RawPositionBook {
  instrument: string;
  time: string;
  price: string;
  bucketWidth: string;
  buckets: RawBucket[];
}

interface RawResponse {
  positionBook?: RawPositionBook;
  errorMessage?: string;
}

const DEFAULT_HOST = "api-fxpractice.oanda.com";

function parseBucket(b: RawBucket): OandaPositioningBucket {
  return {
    price: parseFloat(b.price),
    long_count_percent: parseFloat(b.longCountPercent),
    short_count_percent: parseFloat(b.shortCountPercent),
  };
}

function sum(values: number[]): number {
  return values.reduce((acc, v) => acc + v, 0);
}

export async function fetchOandaPositioning(
  instrument: string
): Promise<OandaPositioningSnapshot> {
  const token = process.env.OANDA_API_KEY;
  if (!token) {
    throw new Error("OANDA_API_KEY is not set");
  }
  const host = process.env.OANDA_API_HOST ?? DEFAULT_HOST;
  const url = `https://${host}/v3/instruments/${encodeURIComponent(instrument)}/positionBook`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "<unreadable>");
    throw new Error(`OANDA positionBook HTTP ${res.status}: ${body}`);
  }
  const data = (await res.json()) as RawResponse;
  if (data.errorMessage || !data.positionBook) {
    throw new Error(`OANDA positionBook error: ${data.errorMessage ?? "no positionBook in response"}`);
  }

  const raw = data.positionBook;
  const buckets = (raw.buckets ?? []).map(parseBucket);
  const long_pct = sum(buckets.map((b) => b.long_count_percent));
  const short_pct = sum(buckets.map((b) => b.short_count_percent));

  return {
    instrument: raw.instrument,
    oanda_time: raw.time,
    price: parseFloat(raw.price),
    long_pct: Number(long_pct.toFixed(4)),
    short_pct: Number(short_pct.toFixed(4)),
    bucket_width: parseFloat(raw.bucketWidth),
    buckets,
  };
}
