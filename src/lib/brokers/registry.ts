/**
 * Broker adapter registry — maps broker_connections.provider → adapter.
 *
 * Adding a new broker:
 *  1. Implement BrokerAdapter in a new file (alpaca.ts, oanda.ts, etc.)
 *  2. Register it here under its provider tag
 *  3. Add the provider value to the broker_connections check constraint
 *
 * Callers should always go through getBrokerAdapter rather than importing
 * a specific adapter directly — that's what gives us provider-agnostic
 * live execution.
 */
import { ctraderOpenApiAdapter } from "./ctrader-openapi";
import { metaApiMt5Adapter } from "./metaapi-mt5";
import type { BrokerAdapter } from "./types";

const ADAPTERS: Record<string, BrokerAdapter> = {
  metaapi: metaApiMt5Adapter,
  ctrader: ctraderOpenApiAdapter,
};

export function getBrokerAdapter(provider: string): BrokerAdapter | null {
  return ADAPTERS[provider] ?? null;
}

export function listSupportedProviders(): string[] {
  return Object.keys(ADAPTERS);
}
