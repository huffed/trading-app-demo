/**
 * cTrader OAuth — step 1: redirect the signed-in user to cTrader's
 * authorisation URL. After they grant access, cTrader redirects back to
 * /api/brokers/ctrader/callback with a code we exchange for tokens.
 *
 * The `state` param is a random nonce stored in a short-lived cookie so
 * the callback can verify the redirect originated from this session and
 * wasn't replayed from another tab/origin.
 */
import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const CTRADER_AUTH_URL = "https://openapi.ctrader.com/apps/auth";

export async function GET(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  const clientId = process.env.CTRADER_CLIENT_ID;
  if (!clientId) {
    return NextResponse.json(
      { error: "CTRADER_CLIENT_ID not configured" },
      { status: 500 }
    );
  }

  const url = new URL(request.url);
  const redirectUri = `${url.origin}/api/brokers/ctrader/callback`;
  const state = randomBytes(16).toString("hex");

  const authUrl = new URL(CTRADER_AUTH_URL);
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("scope", "accounts trading");
  authUrl.searchParams.set("product", "web");
  authUrl.searchParams.set("state", state);

  const res = NextResponse.redirect(authUrl.toString());
  // 10-min nonce. HttpOnly + same-site so it can't be read by JS or
  // smuggled cross-site, but still survives the cTrader redirect.
  res.cookies.set("ctrader_oauth_state", state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 600,
    path: "/",
  });
  return res;
}
