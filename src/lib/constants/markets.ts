/**
 * Curated forex and commodity symbol catalog.
 *
 * These symbols are confirmed to work with Twelve Data's price feed using the
 * exact strings below. Keeps the LLM and discovery engine grounded in a known
 * universe instead of free-form ticker generation.
 */

export type InstrumentClass = "forex" | "commodity";

export interface InstrumentMeta {
  symbol: string;
  name: string;
  assetClass: InstrumentClass;
  category: "major" | "minor" | "metal" | "energy" | "agriculture";
  pipSize: number;
  description: string;
}

export const FOREX_PAIRS: InstrumentMeta[] = [
  {
    symbol: "EUR/USD",
    name: "Euro / US Dollar",
    assetClass: "forex",
    category: "major",
    pipSize: 0.0001,
    description: "Most liquid pair globally. Tight spreads, deep institutional flow.",
  },
  {
    symbol: "GBP/USD",
    name: "British Pound / US Dollar",
    assetClass: "forex",
    category: "major",
    pipSize: 0.0001,
    description: "Volatile London/NY overlap. Sensitive to UK macro and Fed differentials.",
  },
  {
    symbol: "USD/JPY",
    name: "US Dollar / Japanese Yen",
    assetClass: "forex",
    category: "major",
    pipSize: 0.01,
    description: "Risk-on/off bellwether. Moves on rate differentials and BoJ policy.",
  },
  {
    symbol: "USD/CHF",
    name: "US Dollar / Swiss Franc",
    assetClass: "forex",
    category: "major",
    pipSize: 0.0001,
    description: "Safe-haven inverse. Often opposite to EUR/USD.",
  },
  {
    symbol: "AUD/USD",
    name: "Australian Dollar / US Dollar",
    assetClass: "forex",
    category: "major",
    pipSize: 0.0001,
    description: "Commodity currency tied to China demand and iron ore.",
  },
  {
    symbol: "USD/CAD",
    name: "US Dollar / Canadian Dollar",
    assetClass: "forex",
    category: "major",
    pipSize: 0.0001,
    description: "Highly correlated with crude oil moves.",
  },
  {
    symbol: "NZD/USD",
    name: "New Zealand Dollar / US Dollar",
    assetClass: "forex",
    category: "major",
    pipSize: 0.0001,
    description: "Carry-trade favorite, sensitive to RBNZ decisions and dairy prices.",
  },
  {
    symbol: "EUR/GBP",
    name: "Euro / British Pound",
    assetClass: "forex",
    category: "minor",
    pipSize: 0.0001,
    description: "Range-bound cross, popular for mean-reversion strategies.",
  },
  {
    symbol: "EUR/JPY",
    name: "Euro / Japanese Yen",
    assetClass: "forex",
    category: "minor",
    pipSize: 0.01,
    description: "Volatile cross capturing both EUR and JPY trends.",
  },
  {
    symbol: "GBP/JPY",
    name: "British Pound / Japanese Yen",
    assetClass: "forex",
    category: "minor",
    pipSize: 0.01,
    description: "Highest-volatility major cross. Big pip ranges, wider stops needed.",
  },
];

export const COMMODITIES: InstrumentMeta[] = [
  {
    symbol: "XAU/USD",
    name: "Gold (spot)",
    assetClass: "commodity",
    category: "metal",
    pipSize: 0.01,
    description: "Inflation hedge, safe haven. Inversely correlated with USD.",
  },
  {
    symbol: "XAG/USD",
    name: "Silver (spot)",
    assetClass: "commodity",
    category: "metal",
    pipSize: 0.001,
    description: "Industrial + monetary metal. More volatile than gold.",
  },
  {
    symbol: "USOIL",
    name: "WTI Crude Oil",
    assetClass: "commodity",
    category: "energy",
    pipSize: 0.01,
    description: "US benchmark crude. Driven by inventory data and OPEC supply.",
  },
  {
    symbol: "UKOIL",
    name: "Brent Crude Oil",
    assetClass: "commodity",
    category: "energy",
    pipSize: 0.01,
    description: "Global oil benchmark. Sensitive to geopolitical risk in EMEA.",
  },
  {
    symbol: "NATGAS",
    name: "Natural Gas",
    assetClass: "commodity",
    category: "energy",
    pipSize: 0.001,
    description: "Highly seasonal. Storage reports drive sharp moves.",
  },
];

export const INSTRUMENT_CATALOG: InstrumentMeta[] = [...FOREX_PAIRS, ...COMMODITIES];

const CATALOG_BY_SYMBOL: Map<string, InstrumentMeta> = new Map(
  INSTRUMENT_CATALOG.map((m) => [m.symbol.toUpperCase(), m])
);

export function getInstrumentMeta(symbol: string): InstrumentMeta | null {
  return CATALOG_BY_SYMBOL.get(symbol.toUpperCase()) ?? null;
}

export function isCurrencyPair(symbol: string): boolean {
  return /^[A-Z]{3}\/[A-Z]{3}$/.test(symbol.toUpperCase());
}

/**
 * Resolve the asset class for a given symbol. Falls back to a sensible default
 * when the symbol isn't in the curated catalog.
 */
export function inferAssetClass(symbol: string, fallback = "equity"): string {
  const meta = getInstrumentMeta(symbol);
  if (meta) return meta.assetClass;
  if (isCurrencyPair(symbol)) return "forex";
  return fallback;
}

/**
 * Display unit for position sizing — "shares", "lots", "contracts".
 * Forex uses lots (1 lot = 100,000 base units). Commodities are typically
 * traded as contracts/units depending on instrument; we surface "units" so
 * the language is correct without overstating contract semantics in paper mode.
 */
export function getQuantityUnit(symbolOrAssetClass: string): string {
  const lower = symbolOrAssetClass.toLowerCase();
  if (lower === "forex") return "units";
  if (lower === "commodity") return "units";
  if (lower === "crypto") return "coins";
  if (lower === "equity") return "shares";
  if (lower === "option") return "contracts";
  if (lower === "future") return "contracts";

  // Treat as a symbol — resolve via catalog
  const meta = getInstrumentMeta(symbolOrAssetClass);
  if (meta?.assetClass === "forex") return "units";
  if (meta?.assetClass === "commodity") return "units";
  if (isCurrencyPair(symbolOrAssetClass)) return "units";
  return "shares";
}

/**
 * Pluralized helper for "1 share" / "5 shares".
 */
export function getQuantityUnitFor(symbolOrAssetClass: string, quantity: number): string {
  const unit = getQuantityUnit(symbolOrAssetClass);
  if (quantity === 1) {
    if (unit === "shares") return "share";
    if (unit === "contracts") return "contract";
    if (unit === "coins") return "coin";
    if (unit === "units") return "unit";
  }
  return unit;
}
