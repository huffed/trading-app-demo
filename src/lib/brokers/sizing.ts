import type { BrokerSymbolSpec } from "./types";

/**
 * Convert a notional dollar amount to a broker lot size, respecting the
 * symbol's contractSize and volumeStep. For forex with contractSize=100k,
 * $1100 notional at price 1.27 = 1100 / (100000 * 1.27) ≈ 0.00866 → rounds
 * to 0.01 (the typical minVolume / volumeStep on MT5 brokers).
 *
 * Lives at brokers/sizing.ts (provider-neutral) so the scan engine can
 * call it without having to import a specific broker module.
 */
export function notionalToLots(
  notionalUsd: number,
  currentPrice: number,
  spec: Pick<BrokerSymbolSpec, "contractSize" | "volumeStep" | "minVolume" | "maxVolume">
): number {
  if (currentPrice <= 0 || spec.contractSize <= 0) return 0;
  const rawLots = notionalUsd / (spec.contractSize * currentPrice);
  const stepped = Math.round(rawLots / spec.volumeStep) * spec.volumeStep;
  const clamped = Math.min(Math.max(stepped, spec.minVolume), spec.maxVolume);
  // Avoid floating-point dust like 0.010000000000001
  return Number(clamped.toFixed(4));
}
