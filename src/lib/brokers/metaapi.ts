/**
 * Thin wrapper around MetaApi.cloud's REST endpoints. MetaApi bridges
 * MT4/MT5 brokers (FTMO, ICMarkets, OANDA, etc.) over a clean HTTP API
 * so we don't have to run an MT5 client ourselves.
 *
 * The user signs up at metaapi.cloud, provisions their MT5 account in
 * MetaApi's dashboard (uploading login/password/server there), and pastes
 * the resulting auth-token + account_id into our app. We never see the
 * raw MT5 credentials.
 */

export type MetaApiRegion = "london" | "new-york" | "singapore";

const REGION_HOSTS: Record<MetaApiRegion, string> = {
  london: "https://mt-client-api-v1.london.agiliumtrade.ai",
  "new-york": "https://mt-client-api-v1.new-york.agiliumtrade.ai",
  singapore: "https://mt-client-api-v1.singapore.agiliumtrade.ai",
};

export interface MetaApiAccountInfo {
  broker?: string;
  currency?: string;
  server?: string;
  balance: number;
  equity: number;
  margin?: number;
  freeMargin?: number;
  leverage?: number;
  name?: string;
  login?: number;
  type?: string;
  platform?: string;
}

export interface MetaApiPosition {
  id: string;
  symbol: string;
  type: string; // "POSITION_TYPE_BUY" | "POSITION_TYPE_SELL"
  volume: number; // lots
  openPrice: number;
  currentPrice?: number;
  profit: number;
  swap?: number;
  commission?: number;
  time?: string;
  stopLoss?: number;
  takeProfit?: number;
}

interface MetaApiError extends Error {
  status?: number;
}

function buildHeaders(token: string): HeadersInit {
  return {
    "auth-token": token,
    Accept: "application/json",
  };
}

async function call<T>(
  region: MetaApiRegion,
  token: string,
  accountId: string,
  path: string
): Promise<T> {
  const host = REGION_HOSTS[region] ?? REGION_HOSTS.london;
  const url = `${host}/users/current/accounts/${encodeURIComponent(accountId)}${path}`;
  const res = await fetch(url, { headers: buildHeaders(token) });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const err: MetaApiError = new Error(
      `MetaApi ${res.status} ${res.statusText}${body ? `: ${body.slice(0, 200)}` : ""}`
    );
    err.status = res.status;
    throw err;
  }
  return (await res.json()) as T;
}

export async function fetchAccountInfo(
  token: string,
  accountId: string,
  region: MetaApiRegion = "london"
): Promise<MetaApiAccountInfo> {
  return call<MetaApiAccountInfo>(region, token, accountId, "/account-information");
}

export async function fetchPositions(
  token: string,
  accountId: string,
  region: MetaApiRegion = "london"
): Promise<MetaApiPosition[]> {
  return call<MetaApiPosition[]>(region, token, accountId, "/positions");
}

export interface MetaApiSnapshot {
  account: MetaApiAccountInfo;
  positions: MetaApiPosition[];
  fetched_at: string;
}

/**
 * Test the connection AND return a full snapshot in one shot. Used by the
 * settings page "Test connection" button and the account-display widget.
 */
export async function fetchSnapshot(
  token: string,
  accountId: string,
  region: MetaApiRegion = "london"
): Promise<MetaApiSnapshot> {
  const [account, positions] = await Promise.all([
    fetchAccountInfo(token, accountId, region),
    fetchPositions(token, accountId, region),
  ]);
  return { account, positions, fetched_at: new Date().toISOString() };
}

/**
 * Translate raw provider errors into user-friendly strings. Avoids
 * surfacing the auth-token in any message that bubbles to the UI.
 */
export function describeMetaApiError(err: unknown): string {
  if (!(err instanceof Error)) return "MetaApi request failed.";
  const msg = err.message;
  if (/401|unauthor/i.test(msg)) return "MetaApi token rejected — check the token in your account.";
  if (/404/i.test(msg)) return "Account ID not found in MetaApi. Confirm it's deployed and active.";
  if (/timeout|fetch|ECONNREFUSED|ENOTFOUND/i.test(msg)) {
    return "Network error reaching MetaApi. Try again in a moment.";
  }
  if (/429/i.test(msg)) return "MetaApi rate limit hit. Wait a minute and retry.";
  return msg.replace(/auth-token[^\s]*/gi, "auth-token=***");
}
