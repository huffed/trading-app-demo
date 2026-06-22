/**
 * Admin endpoint: snapshot OANDA positioning for one or more instruments
 * and persist into oanda_positioning_cache.
 *
 * Wired to scripts/oanda-positioning-cron.sh which runs every 20 min.
 * OANDA's positionBook itself only refreshes on a 20-min cadence, so
 * tighter polling wastes API calls without yielding new data.
 *
 * Usage:
 *   curl -H "Authorization: Bearer $CRON_SECRET" \
 *     "http://localhost:3000/api/admin/snapshot-oanda-positioning?instruments=XAU_USD"
 *
 * Multiple instruments: comma-separated. Defaults to XAU_USD if no
 * instruments param is supplied.
 *
 * Returns: { snapshots: [{ instrument, long_pct, short_pct, oanda_time }], errors: [...] }
 */
import { NextResponse } from "next/server";
import { verifyAdminAuth } from "@/lib/api/admin-auth";
import { logger } from "@/lib/logger";
import {
  fetchOandaPositioning,
  type OandaPositioningSnapshot,
} from "@/lib/market-data/oanda-positioning";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const DEFAULT_INSTRUMENTS = ["XAU_USD"];

interface SnapshotResult {
  instrument: string;
  long_pct: number;
  short_pct: number;
  oanda_time: string;
}

interface SnapshotError {
  instrument: string;
  error: string;
}

export async function GET(request: Request) {
  const authError = verifyAdminAuth(request);
  if (authError) return authError;

  const url = new URL(request.url);
  const param = url.searchParams.get("instruments");
  const instruments = param
    ? param.split(",").map((s) => s.trim()).filter(Boolean)
    : DEFAULT_INSTRUMENTS;

  if (instruments.length === 0) {
    return NextResponse.json(
      { error: "instruments must be a non-empty list", code: "validation_error" },
      { status: 400 }
    );
  }

  const supabase = createAdminClient();
  const snapshots: SnapshotResult[] = [];
  const errors: SnapshotError[] = [];

  for (const instrument of instruments) {
    let snap: OandaPositioningSnapshot;
    try {
      snap = await fetchOandaPositioning(instrument);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("snapshot-oanda-positioning", `fetch failed for ${instrument}`, err);
      errors.push({ instrument, error: msg });
      continue;
    }

    // No generated DB types in this repo, so the supabase-js overloads
    // only know about built-in tables. Cast the row payload through
    // `never` so TS accepts the upsert; the runtime shape is the
    // schema defined in migration 00034.
    const { error: upsertError } = await supabase
      .from("oanda_positioning_cache")
      .upsert(
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
        {
          instrument: snap.instrument,
          oanda_time: snap.oanda_time,
          fetched_at: new Date().toISOString(),
          price: snap.price,
          long_pct: snap.long_pct,
          short_pct: snap.short_pct,
          bucket_width: snap.bucket_width,
          buckets: snap.buckets,
        } as never,
        { onConflict: "instrument,oanda_time" }
      );

    if (upsertError) {
      logger.error("snapshot-oanda-positioning", `upsert failed for ${instrument}`, upsertError);
      errors.push({ instrument, error: upsertError.message });
      continue;
    }

    snapshots.push({
      instrument: snap.instrument,
      long_pct: snap.long_pct,
      short_pct: snap.short_pct,
      oanda_time: snap.oanda_time,
    });
    logger.info(
      "snapshot-oanda-positioning",
      `${snap.instrument} long=${snap.long_pct.toFixed(2)}% short=${snap.short_pct.toFixed(2)}% @ ${snap.oanda_time}`
    );
  }

  const status = errors.length > 0 && snapshots.length === 0 ? 502 : 200;
  return NextResponse.json({ snapshots, errors }, { status });
}
