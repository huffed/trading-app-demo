/**
 * cTrader Open API adapter — STUB. The actual proto/TCP trading client
 * lives in a follow-up commit (Phase 2). This stub exists so the adapter
 * registry can register cTrader connections today, fail loudly if the
 * scan engine tries to trade through one, and unblock the OAuth + UI
 * flow that doesn't need trading itself.
 */
import type { BrokerAdapter } from "./types";

const NOT_IMPLEMENTED =
  "cTrader Open API trading is not implemented yet — Phase 2 work. Connection saved but no orders can be placed through it.";

function notImplemented(): never {
  throw new Error(NOT_IMPLEMENTED);
}

export const ctraderOpenApiAdapter: BrokerAdapter = {
  provider: "ctrader",

  async fetchAccountInfo() {
    notImplemented();
  },

  async fetchPositions() {
    notImplemented();
  },

  async fetchPosition() {
    notImplemented();
  },

  async fetchSnapshot() {
    notImplemented();
  },

  async fetchSymbolSpec() {
    notImplemented();
  },

  async placeMarketOrder() {
    notImplemented();
  },

  async closePosition() {
    notImplemented();
  },

  describeError(err) {
    return err instanceof Error ? err.message : String(err);
  },
};
