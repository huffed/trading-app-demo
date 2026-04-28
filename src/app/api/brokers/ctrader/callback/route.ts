/**
 * cTrader OAuth — step 2: handle the redirect back from cTrader, swap the
 * authorisation code for tokens, fetch the user's trading accounts, and
 * persist a broker_connections row per account.
 *
 * State validation: the connect route stores a random nonce in an
 * HttpOnly cookie; cTrader echoes it back via ?state=. Mismatch → reject.
 */
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const TOKEN_URL = "https://openapi.ctrader.com/apps/token";
const ACCOUNTS_URL = "https://openapi.ctrader.com/connect/tradingaccounts";

interface TokenResponse {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  expiresIn: number;
}

interface TradingAccount {
  ctidTraderAccountId: number;
  accountNumber?: string;
  accountId?: string;
  brokerName?: string;
  live?: boolean;
  traderRegistrationTimestamp?: number;
  depositAssetId?: number;
  symbolId?: number[];
}

interface AccountsResponse {
  data: TradingAccount[];
}

function errorRedirect(origin: string, message: string) {
  const url = new URL("/settings/brokers", origin);
  url.searchParams.set("ctrader_error", message);
  return NextResponse.redirect(url);
}

async function exchangeCodeForTokens(args: {
  code: string;
  redirectUri: string;
  clientId: string;
  clientSecret: string;
}): Promise<TokenResponse | { error: string }> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: args.code,
      redirect_uri: args.redirectUri,
      client_id: args.clientId,
      client_secret: args.clientSecret,
    }).toString(),
  });
  if (!res.ok) {
    return { error: `Token exchange failed: ${res.status} ${await res.text()}` };
  }
  const tokens = (await res.json()) as TokenResponse;
  if (!tokens.accessToken || !tokens.refreshToken) {
    return { error: "Token response missing accessToken/refreshToken" };
  }
  return tokens;
}

async function fetchTradingAccounts(
  accessToken: string
): Promise<TradingAccount[] | { error: string }> {
  const res = await fetch(ACCOUNTS_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    return { error: `Failed to fetch accounts: ${res.status} ${await res.text()}` };
  }
  const json = (await res.json()) as AccountsResponse;
  const accounts = json.data ?? [];
  if (accounts.length === 0) {
    return { error: "cTrader returned zero trading accounts for this token" };
  }
  return accounts;
}

function readStateCookie(cookieHeader: string): string | null {
  return (
    cookieHeader
      .split(";")
      .map((c) => c.trim())
      .find((c) => c.startsWith("ctrader_oauth_state="))
      ?.split("=")[1] ?? null
  );
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    return errorRedirect(url.origin, `cTrader denied access: ${error}`);
  }
  if (!code || !state) {
    return errorRedirect(url.origin, "Missing code or state from cTrader");
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.redirect(new URL("/login", url.origin));
  }

  const stateCookie = readStateCookie(request.headers.get("cookie") ?? "");
  if (!stateCookie || stateCookie !== state) {
    return errorRedirect(url.origin, "OAuth state mismatch — request may have been tampered with");
  }

  const clientId = process.env.CTRADER_CLIENT_ID;
  const clientSecret = process.env.CTRADER_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return errorRedirect(url.origin, "cTrader credentials not configured on server");
  }

  const redirectUri = `${url.origin}/api/brokers/ctrader/callback`;
  const tokens = await exchangeCodeForTokens({ code, redirectUri, clientId, clientSecret });
  if ("error" in tokens) return errorRedirect(url.origin, tokens.error);

  const accounts = await fetchTradingAccounts(tokens.accessToken);
  if ("error" in accounts) return errorRedirect(url.origin, accounts.error);

  // Step 2c: replace any existing cTrader connections for this user with
  // the freshly-authorised set. Avoids duplicate rows when the user
  // re-runs the OAuth flow (e.g. token expired, reconnected).
  await supabase
    .from("broker_connections")
    .delete()
    .eq("user_id", user.id)
    .eq("provider", "ctrader");

  const expiresAt = new Date(Date.now() + tokens.expiresIn * 1000).toISOString();
  const rows = accounts.map((acc) => ({
    user_id: user.id,
    provider: "ctrader",
    label: `cTrader • ${acc.accountNumber ?? acc.accountId ?? acc.ctidTraderAccountId}`,
    api_token: tokens.accessToken,
    refresh_token: tokens.refreshToken,
    token_expires_at: expiresAt,
    account_id: String(acc.ctidTraderAccountId),
    account_login: acc.accountNumber ?? acc.accountId ?? null,
    broker_name: acc.brokerName ?? null,
    server: acc.live ? "live" : "demo",
    region: null,
    status: "active",
    account_snapshot: acc as unknown as Record<string, unknown>,
    last_synced_at: new Date().toISOString(),
  }));

  const { error: insertErr } = await supabase.from("broker_connections").insert(rows);
  if (insertErr) {
    return errorRedirect(url.origin, `Failed to save connection: ${insertErr.message}`);
  }

  // Success — clear the state cookie and bounce back to the brokers page.
  const success = NextResponse.redirect(
    new URL(`/settings/brokers?ctrader_connected=${accounts.length}`, url.origin)
  );
  success.cookies.set("ctrader_oauth_state", "", { maxAge: 0, path: "/" });
  return success;
}
