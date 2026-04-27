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
  /** Units per 1 lot. Forex = 100,000 base currency. Gold = 100 oz.
   *  Silver = 5,000 oz. Crude/Brent = 1,000 barrels. NatGas = 10,000 mmBtu. */
  contractSize: number;
  description: string;
}

export const FOREX_PAIRS: InstrumentMeta[] = [
  {
    symbol: "EUR/USD",
    name: "Euro / US Dollar",
    assetClass: "forex",
    category: "major",
    pipSize: 0.0001,
    contractSize: 100000,
    description: "Most liquid pair globally. Tight spreads, deep institutional flow.",
  },
  {
    symbol: "GBP/USD",
    name: "British Pound / US Dollar",
    assetClass: "forex",
    category: "major",
    pipSize: 0.0001,
    contractSize: 100000,
    description: "Volatile London/NY overlap. Sensitive to UK macro and Fed differentials.",
  },
  {
    symbol: "USD/JPY",
    name: "US Dollar / Japanese Yen",
    assetClass: "forex",
    category: "major",
    pipSize: 0.01,
    contractSize: 100000,
    description: "Risk-on/off bellwether. Moves on rate differentials and BoJ policy.",
  },
  {
    symbol: "USD/CHF",
    name: "US Dollar / Swiss Franc",
    assetClass: "forex",
    category: "major",
    pipSize: 0.0001,
    contractSize: 100000,
    description: "Safe-haven inverse. Often opposite to EUR/USD.",
  },
  {
    symbol: "AUD/USD",
    name: "Australian Dollar / US Dollar",
    assetClass: "forex",
    category: "major",
    pipSize: 0.0001,
    contractSize: 100000,
    description: "Commodity currency tied to China demand and iron ore.",
  },
  {
    symbol: "USD/CAD",
    name: "US Dollar / Canadian Dollar",
    assetClass: "forex",
    category: "major",
    pipSize: 0.0001,
    contractSize: 100000,
    description: "Highly correlated with crude oil moves.",
  },
  {
    symbol: "NZD/USD",
    name: "New Zealand Dollar / US Dollar",
    assetClass: "forex",
    category: "major",
    pipSize: 0.0001,
    contractSize: 100000,
    description: "Carry-trade favorite, sensitive to RBNZ decisions and dairy prices.",
  },
  {
    symbol: "EUR/GBP",
    name: "Euro / British Pound",
    assetClass: "forex",
    category: "minor",
    pipSize: 0.0001,
    contractSize: 100000,
    description: "Range-bound cross, popular for mean-reversion strategies.",
  },
  {
    symbol: "EUR/JPY",
    name: "Euro / Japanese Yen",
    assetClass: "forex",
    category: "minor",
    pipSize: 0.01,
    contractSize: 100000,
    description: "Volatile cross capturing both EUR and JPY trends.",
  },
  {
    symbol: "GBP/JPY",
    name: "British Pound / Japanese Yen",
    assetClass: "forex",
    category: "minor",
    pipSize: 0.01,
    contractSize: 100000,
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
    contractSize: 100,
    description: "Inflation hedge, safe haven. Inversely correlated with USD.",
  },
  {
    symbol: "XAG/USD",
    name: "Silver (spot)",
    assetClass: "commodity",
    category: "metal",
    pipSize: 0.001,
    contractSize: 5000,
    description: "Industrial + monetary metal. More volatile than gold.",
  },
  {
    symbol: "USOIL",
    name: "WTI Crude Oil",
    assetClass: "commodity",
    category: "energy",
    pipSize: 0.01,
    contractSize: 1000,
    description: "US benchmark crude. Driven by inventory data and OPEC supply.",
  },
  {
    symbol: "UKOIL",
    name: "Brent Crude Oil",
    assetClass: "commodity",
    category: "energy",
    pipSize: 0.01,
    contractSize: 1000,
    description: "Global oil benchmark. Sensitive to geopolitical risk in EMEA.",
  },
  {
    symbol: "NATGAS",
    name: "Natural Gas",
    assetClass: "commodity",
    category: "energy",
    pipSize: 0.001,
    contractSize: 10000,
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

/**
 * Units per 1 lot for a given symbol. Forex defaults to 100,000 base
 * currency units when the catalog doesn't list it. Stocks/ETFs return 1
 * (one lot = one share).
 */
export function getContractSize(symbol: string, assetClass?: string): number {
  const meta = getInstrumentMeta(symbol);
  if (meta) return meta.contractSize;
  if (assetClass === "forex" || isCurrencyPair(symbol)) return 100000;
  if (assetClass === "commodity") return 1; // unknown commodity — treat 1 unit per lot
  return 1; // equity/crypto default
}

/**
 * Sensible default leverage by asset class. Real prop firms vary:
 *  - FTMO: 1:100 forex, 1:30 commodities/indices, 1:5 stocks
 *  - Topstep (futures-only): 1:10-1:30 effective
 *  - Trading 212 retail: 1:30 forex, 1:20 indices
 * 30 is a middle-of-the-road default that fits all and won't blow accounts.
 */
export function defaultLeverage(assetClass: string): number {
  if (assetClass === "forex") return 100;
  if (assetClass === "commodity") return 30;
  if (assetClass === "crypto") return 5;
  return 1;
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
