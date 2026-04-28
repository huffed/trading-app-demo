/**
 * cTrader Open API adapter — implements BrokerAdapter using the
 * protobuf-over-TLS client in ./ctrader/.
 *
 * Lifecycle: each adapter call opens a fresh session (TLS connect →
 * application auth → account auth → resolve symbol map), does its
 * work, and closes. Adds ~150-300ms latency per call which is fine
 * for hourly-cron cadence; pooling would buy back ~250ms but cost
 * heartbeat + invalidation complexity that doesn't pay back at scale 1.
 *
 * Volume convention: cTrader's protobuf encodes volume in 1/100-lot
 * units (a.k.a. "centi-lots"). 100 = 1.00 lot, 1 = 0.01 lot. The
 * adapter receives volume in lots from live-execution.ts and converts.
 */
import { closePosition as protoClose, fetchTrader, newMarketOrder, reconcile, symbolById } from "./ctrader/messages";
import { lookupType } from "./ctrader/proto/loader";
import { withCTraderSession, type CTraderSession } from "./ctrader/session";
import type {
  BrokerAdapter,
  BrokerAccountInfo,
  BrokerPosition,
  BrokerSnapshot,
  BrokerSymbolSpec,
  MarketOrderInput,
  MarketOrderResult,
} from "./types";

function lotsToCtraderVolume(lots: number): number {
  // cTrader uses 1/100-lot integer units. Round to nearest int — caller
  // is responsible for clamping to the symbol's stepVolume / minVolume.
  return Math.round(lots * 100);
}

function ctraderVolumeToLots(volume: number): number {
  return volume / 100;
}

function appSideToTradeSide(side: "buy" | "sell"): 1 | 2 {
  return side === "buy" ? 1 : 2;
}

function tradeSideToAppSide(tradeSide: number): "buy" | "sell" {
  return tradeSide === 2 ? "sell" : "buy";
}

function requireSymbolId(session: CTraderSession, appSymbol: string): number {
  const id = session.resolveSymbolId(appSymbol);
  if (id == null) {
    throw new Error(
      `cTrader: symbol "${appSymbol}" not found on this account — check spelling or instrument permissions`
    );
  }
  return id;
}

export const ctraderOpenApiAdapter: BrokerAdapter = {
  provider: "ctrader",

  async fetchAccountInfo(conn) {
    return withCTraderSession(conn, async (s) => {
      const t = await fetchTrader(s.client, s.ctidTraderAccountId);
      // Trader.balance and equity are int64 in 1/100 of the deposit
      // currency. Divide by 100 to get the human-readable amount.
      const balance = (t.trader.balance ?? 0) / 100;
      const equity = t.trader.equity != null ? t.trader.equity / 100 : balance;
      const info: BrokerAccountInfo = {
        balance,
        equity,
        leverage: t.trader.leverageInCents ? t.trader.leverageInCents / 100 : undefined,
        login: String(s.ctidTraderAccountId),
        platform: "cTrader",
      };
      return info;
    });
  },

  async fetchPositions(conn) {
    return withCTraderSession(conn, async (s) => mapPositions(s, await reconcile(s.client, s.ctidTraderAccountId)));
  },

  async fetchPosition(conn, positionId) {
    const id = Number(positionId);
    if (!Number.isFinite(id)) return null;
    return withCTraderSession(conn, async (s) => {
      const all = mapPositions(s, await reconcile(s.client, s.ctidTraderAccountId));
      return all.find((p) => p.id === positionId) ?? null;
    });
  },

  async fetchSnapshot(conn) {
    return withCTraderSession(conn, async (s) => {
      const [t, r] = await Promise.all([
        fetchTrader(s.client, s.ctidTraderAccountId),
        reconcile(s.client, s.ctidTraderAccountId),
      ]);
      const balance = (t.trader.balance ?? 0) / 100;
      const equity = t.trader.equity != null ? t.trader.equity / 100 : balance;
      const snapshot: BrokerSnapshot = {
        account: {
          balance,
          equity,
          leverage: t.trader.leverageInCents ? t.trader.leverageInCents / 100 : undefined,
          login: String(s.ctidTraderAccountId),
          platform: "cTrader",
        },
        positions: mapPositions(s, r),
        fetched_at: new Date().toISOString(),
      };
      return snapshot;
    });
  },

  async fetchSymbolSpec(conn, appSymbol) {
    return withCTraderSession(conn, async (s) => {
      const symbolId = requireSymbolId(s, appSymbol);
      const res = await symbolById(s.client, s.ctidTraderAccountId, [symbolId]);
      const sym = res.symbol[0];
      if (!sym) throw new Error(`cTrader: SymbolByIdRes returned no entry for ${appSymbol}`);
      const spec: BrokerSymbolSpec = {
        symbol: appSymbol.toUpperCase(),
        // lotSize is units-per-lot from the broker's catalogue (e.g.
        // 100,000 for forex). Same semantics as MetaApi's contractSize.
        contractSize: sym.lotSize,
        // step/min/maxVolume come back in the 1/100-lot encoding the
        // trading API uses. Convert to lots so the rest of our system
        // (which speaks lots) doesn't have to know cTrader's encoding.
        volumeStep: ctraderVolumeToLots(sym.stepVolume),
        minVolume: ctraderVolumeToLots(sym.minVolume),
        maxVolume: ctraderVolumeToLots(sym.maxVolume),
        digits: sym.digits,
      };
      return spec;
    });
  },

  async placeMarketOrder(conn, input: MarketOrderInput): Promise<MarketOrderResult> {
    return withCTraderSession(conn, async (s) => {
      const symbolId = requireSymbolId(s, input.appSymbol);
      const event = await newMarketOrder(s.client, {
        ctidTraderAccountId: s.ctidTraderAccountId,
        symbolId,
        tradeSide: appSideToTradeSide(input.side),
        volume: lotsToCtraderVolume(input.volume),
        stopLoss: input.stopLoss,
        takeProfit: input.takeProfit,
        comment: input.comment,
        label: input.clientId,
      });
      // The execution event carries position + order references when the
      // order fills. Pull both ids out so the paper position can be
      // correlated against the broker's record.
      const decoded = decodeExecutionEvent(event.payload);
      return {
        orderId: decoded.orderId ? String(decoded.orderId) : "",
        positionId: decoded.positionId ? String(decoded.positionId) : "",
      };
    });
  },

  async closePosition(conn, positionId) {
    const id = Number(positionId);
    if (!Number.isFinite(id)) {
      throw new Error(`cTrader: invalid positionId "${positionId}"`);
    }
    return withCTraderSession(conn, async (s) => {
      // We need the position's current volume to issue a full close —
      // cTrader requires explicit volume, no "close all" shortcut.
      const r = await reconcile(s.client, s.ctidTraderAccountId);
      const target = r.position.find((p) => p.positionId === id);
      if (!target) {
        throw new Error(`cTrader: position ${positionId} not open on account ${conn.account_id}`);
      }
      const event = await protoClose(
        s.client,
        s.ctidTraderAccountId,
        id,
        target.tradeData.volume
      );
      const decoded = decodeExecutionEvent(event.payload);
      return { orderId: decoded.orderId ? String(decoded.orderId) : "" };
    });
  },

  describeError(err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/CH_CLIENT_AUTH_FAILURE/.test(msg)) {
      return "cTrader application auth rejected — your Open API app may not yet be Active (KYC pending) or the client_id/secret is wrong.";
    }
    if (/OA_AUTH_TOKEN_EXPIRED|TOKEN_EXPIRED/.test(msg)) {
      return "cTrader access token expired — reconnect via the OAuth flow on the brokers settings page.";
    }
    if (/timeout/i.test(msg)) {
      return "cTrader request timed out — check network or the OA proxy status.";
    }
    return msg.replace(/access[_-]?token[^\s]*/gi, "access_token=***");
  },
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function mapPositions(
  session: CTraderSession,
  res: { position: { positionId: number; tradeData: { symbolId: number; volume: number; tradeSide: number; openTimestamp?: number }; price: number; stopLoss?: number; takeProfit?: number; swap?: number; commission?: number }[] }
): BrokerPosition[] {
  return res.position.map((p) => ({
    id: String(p.positionId),
    symbol: session.resolveSymbolName(p.tradeData.symbolId) ?? `id:${p.tradeData.symbolId}`,
    side: tradeSideToAppSide(p.tradeData.tradeSide),
    volume: ctraderVolumeToLots(p.tradeData.volume),
    openPrice: p.price,
    profit: 0, // Live profit isn't on the position; comes via spot subscriptions or fetchTrader.
    swap: p.swap,
    commission: p.commission,
    time: p.tradeData.openTimestamp ? new Date(p.tradeData.openTimestamp).toISOString() : undefined,
    stopLoss: p.stopLoss,
    takeProfit: p.takeProfit,
  }));
}

interface ExecutionEventDecoded {
  orderId?: number;
  positionId?: number;
}

/** Pull the order/position ids out of a PROTO_OA_EXECUTION_EVENT
 *  payload. We don't need the full event shape — just the references. */
function decodeExecutionEvent(payload: Uint8Array): ExecutionEventDecoded {
  const T = lookupType("ProtoOAExecutionEvent");
  const decoded = T.decode(payload) as unknown as {
    order?: { orderId?: number };
    position?: { positionId?: number };
  };
  return {
    orderId: decoded.order?.orderId,
    positionId: decoded.position?.positionId,
  };
}
