/**
 * Session helper — wraps the connect → app auth → account auth → work
 * → close lifecycle so adapter methods stay focused on their actual
 * trading work.
 *
 * Each call opens a fresh TLS connection. We deliberately don't pool
 * because the scan engine fires hourly and each session lasts seconds —
 * the cost of TLS handshake + 2 auth round-trips (~150-300ms total) is
 * acceptable, and pooling adds invalidation/heartbeat complexity that
 * doesn't pay back at this cadence.
 *
 * Symbol-name → symbolId resolution is cached on the session: cTrader's
 * trading API uses numeric ids, but our app uses string symbols ("EUR/USD"),
 * so each session does one ProtoOASymbolsListReq up front and serves
 * subsequent lookups from memory.
 */
import { CTraderClient, ENDPOINTS, type CTraderEndpoint } from "./client";
import {
  accountAuth,
  applicationAuth,
  symbolsList,
  type LightSymbol,
} from "./messages";
import type { BrokerConnection } from "../types";

export interface CTraderSession {
  client: CTraderClient;
  ctidTraderAccountId: number;
  /** Resolve an app-form symbol ("EUR/USD") to cTrader's numeric symbolId.
   *  Returns null if the broker doesn't list it (e.g. symbol disabled or
   *  not in this account's instrument set). */
  resolveSymbolId(appSymbol: string): number | null;
  /** Inverse — for translating execution events / reconcile responses
   *  back to the app's symbol convention. */
  resolveSymbolName(symbolId: number): string | null;
}

interface SessionResolveContext {
  byName: Map<string, number>;
  byId: Map<number, string>;
}

function buildSymbolMaps(symbols: LightSymbol[]): SessionResolveContext {
  const byName = new Map<string, number>();
  const byId = new Map<number, string>();
  for (const s of symbols) {
    if (!s.symbolName) continue;
    const upper = s.symbolName.toUpperCase();
    byName.set(upper, s.symbolId);
    // Also index by the slash-stripped variant for brokers that present
    // forex pairs without a delimiter ("EURUSD") so callers don't have
    // to know which convention this account uses.
    byName.set(upper.replace(/\//g, ""), s.symbolId);
    byId.set(s.symbolId, upper);
  }
  return { byName, byId };
}

function endpointFor(conn: BrokerConnection): CTraderEndpoint {
  // server is set to "live" or "demo" by the OAuth callback based on
  // the account's `live` flag. Default to demo if unset to avoid
  // accidentally pointing a misconfigured connection at the live ring.
  return conn.server === "live" ? ENDPOINTS.live : ENDPOINTS.demo;
}

/**
 * Run `work` against an authenticated cTrader session for the given
 * connection. Always closes the connection on exit, even on failure.
 */
export async function withCTraderSession<T>(
  conn: BrokerConnection,
  work: (session: CTraderSession) => Promise<T>
): Promise<T> {
  const clientId = process.env.CTRADER_CLIENT_ID;
  const clientSecret = process.env.CTRADER_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      "cTrader: CTRADER_CLIENT_ID / CTRADER_CLIENT_SECRET not configured on server"
    );
  }
  const ctidTraderAccountId = Number(conn.account_id);
  if (!Number.isFinite(ctidTraderAccountId) || ctidTraderAccountId <= 0) {
    throw new Error(
      `cTrader: invalid account_id "${conn.account_id}" — expected ctidTraderAccountId integer`
    );
  }

  const client = new CTraderClient(endpointFor(conn));
  try {
    await client.connect();
    await applicationAuth(client, clientId, clientSecret);
    await accountAuth(client, ctidTraderAccountId, conn.api_token);
    const list = await symbolsList(client, ctidTraderAccountId);
    const { byName, byId } = buildSymbolMaps(list.symbol);
    const session: CTraderSession = {
      client,
      ctidTraderAccountId,
      resolveSymbolId: (appSymbol) => byName.get(appSymbol.toUpperCase()) ?? null,
      resolveSymbolName: (symbolId) => byId.get(symbolId) ?? null,
    };
    return await work(session);
  } finally {
    client.close();
  }
}
