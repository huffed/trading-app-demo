/**
 * Resolve the symbol universe from the user's prefer/avoid filters.
 *
 * Defaults to forex + commodities (the catalog we currently support).
 * The user's `prefer_symbols` overrides everything when non-empty —
 * an explicit "I want to trade EUR/USD and GBP/JPY only" intent
 * shouldn't get expanded.
 */
import { COMMODITIES, FOREX_PAIRS, type InstrumentMeta } from "@/lib/constants/markets";
import type { SearchInput } from "../combinatorial-search";

export function filterUniverse(input: SearchInput): string[] {
  if (input.prefer_symbols && input.prefer_symbols.length > 0) {
    const avoid = new Set((input.avoid_symbols ?? []).map((s) => s.toUpperCase()));
    return input.prefer_symbols
      .map((s) => s.toUpperCase())
      .filter((s) => !avoid.has(s));
  }

  const all: InstrumentMeta[] = [...FOREX_PAIRS, ...COMMODITIES];
  const preferClasses = (input.prefer_asset_classes ?? []).map((c) => c.toLowerCase());
  const avoidClasses = (input.avoid_asset_classes ?? []).map((c) => c.toLowerCase());
  const avoidSyms = new Set((input.avoid_symbols ?? []).map((s) => s.toUpperCase()));

  return all
    .filter((m) => preferClasses.length === 0 || preferClasses.includes(m.assetClass))
    .filter((m) => !avoidClasses.includes(m.assetClass))
    .filter((m) => !avoidSyms.has(m.symbol.toUpperCase()))
    .map((m) => m.symbol);
}
