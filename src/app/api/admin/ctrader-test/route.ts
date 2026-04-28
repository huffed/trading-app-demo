/**
 * Admin endpoint: smoke-test the cTrader Open API client by performing
 * application auth. Doesn't require a KYC-cleared app or a live OAuth
 * token — application auth uses our static CLIENT_ID + CLIENT_SECRET
 * pair so we can validate the wire format and proto descriptors today.
 *
 * Usage:
 *   curl -H "Authorization: Bearer $CRON_SECRET" \
 *     "http://localhost:3000/api/admin/ctrader-test?endpoint=demo"
 *
 * A successful run returns { ok: true, stage: "application_auth", ms: N }.
 * Failure exposes the actual error so we know whether the issue is TLS,
 * framing, or the auth call itself.
 */
import { NextResponse } from "next/server";
import { CTraderClient, ENDPOINTS } from "@/lib/brokers/ctrader/client";
import { applicationAuth } from "@/lib/brokers/ctrader/messages";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 500 });
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const clientId = process.env.CTRADER_CLIENT_ID;
  const clientSecret = process.env.CTRADER_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return NextResponse.json(
      { error: "CTRADER_CLIENT_ID / CTRADER_CLIENT_SECRET not set" },
      { status: 500 }
    );
  }

  const url = new URL(request.url);
  const endpoint = (url.searchParams.get("endpoint") ?? "demo") as "demo" | "live";
  const target = ENDPOINTS[endpoint];
  if (!target) {
    return NextResponse.json({ error: `unknown endpoint "${endpoint}"` }, { status: 400 });
  }

  const client = new CTraderClient(target);
  const t0 = Date.now();
  try {
    await client.connect();
    const tConn = Date.now();
    await applicationAuth(client, clientId, clientSecret);
    const tAuth = Date.now();
    return NextResponse.json({
      ok: true,
      stage: "application_auth",
      endpoint: `${target.host}:${target.port}`,
      timing_ms: { tls: tConn - t0, app_auth: tAuth - tConn, total: tAuth - t0 },
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        stage: "application_auth",
        error: err instanceof Error ? err.message : String(err),
        ms: Date.now() - t0,
      },
      { status: 502 }
    );
  } finally {
    client.close();
  }
}
