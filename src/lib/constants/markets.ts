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
  /** ISO base currency (the AAA in AAA/BBB). Forex pair base, or USD for
   *  USD-priced commodities (gold, silver, oil, gas). */
  baseCurrency: string;
  /** ISO quote currency (the BBB). USD for most pairs and commodities, JPY
   *  for yen pairs, etc. Drives notional-to-USD conversion in the
   *  backtest engine. */
  quoteCurrency: string;
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
    baseCurrency: "EUR",
    quoteCurrency: "USD",
    description: "Most liquid pair globally. Tight spreads, deep institutional flow.",
  },
  {
    symbol: "GBP/USD",
    name: "British Pound / US Dollar",
    assetClass: "forex",
    category: "major",
    pipSize: 0.0001,
    contractSize: 100000,
    baseCurrency: "GBP",
    quoteCurrency: "USD",
    description: "Volatile London/NY overlap. Sensitive to UK macro and Fed differentials.",
  },
  {
    symbol: "USD/JPY",
    name: "US Dollar / Japanese Yen",
    assetClass: "forex",
    category: "major",
    pipSize: 0.01,
    contractSize: 100000,
    baseCurrency: "USD",
    quoteCurrency: "JPY",
    description: "Risk-on/off bellwether. Moves on rate differentials and BoJ policy.",
  },
  {
    symbol: "USD/CHF",
    name: "US Dollar / Swiss Franc",
    assetClass: "forex",
    category: "major",
    pipSize: 0.0001,
    contractSize: 100000,
    baseCurrency: "USD",
    quoteCurrency: "CHF",
    description: "Safe-haven inverse. Often opposite to EUR/USD.",
  },
  {
    symbol: "AUD/USD",
    name: "Australian Dollar / US Dollar",
    assetClass: "forex",
    category: "major",
    pipSize: 0.0001,
    contractSize: 100000,
    baseCurrency: "AUD",
    quoteCurrency: "USD",
    description: "Commodity currency tied to China demand and iron ore.",
  },
  {
    symbol: "USD/CAD",
    name: "US Dollar / Canadian Dollar",
    assetClass: "forex",
    category: "major",
    pipSize: 0.0001,
    contractSize: 100000,
    baseCurrency: "USD",
    quoteCurrency: "CAD",
    description: "Highly correlated with crude oil moves.",
  },
  {
    symbol: "NZD/USD",
    name: "New Zealand Dollar / US Dollar",
    assetClass: "forex",
    category: "major",
    pipSize: 0.0001,
    contractSize: 100000,
    baseCurrency: "NZD",
    quoteCurrency: "USD",
    description: "Carry-trade favorite, sensitive to RBNZ decisions and dairy prices.",
  },
  {
    symbol: "EUR/GBP",
    name: "Euro / British Pound",
    assetClass: "forex",
    category: "minor",
    pipSize: 0.0001,
    contractSize: 100000,
    baseCurrency: "EUR",
    quoteCurrency: "GBP",
    description: "Range-bound cross, popular for mean-reversion strategies.",
  },
  {
    symbol: "EUR/JPY",
    name: "Euro / Japanese Yen",
    assetClass: "forex",
    category: "minor",
    pipSize: 0.01,
    contractSize: 100000,
    baseCurrency: "EUR",
    quoteCurrency: "JPY",
    description: "Volatile cross capturing both EUR and JPY trends.",
  },
  {
    symbol: "GBP/JPY",
    name: "British Pound / Japanese Yen",
    assetClass: "forex",
    category: "minor",
    pipSize: 0.01,
    contractSize: 100000,
    baseCurrency: "GBP",
    quoteCurrency: "JPY",
    description: "Highest-volatility major cross. Big pip ranges, wider stops needed.",
  },
  {
    symbol: "CHF/JPY",
    name: "Swiss Franc / Japanese Yen",
    assetClass: "forex",
    category: "minor",
    pipSize: 0.01,
    contractSize: 100000,
    baseCurrency: "CHF",
    quoteCurrency: "JPY",
    description: "Safe-haven JPY cross. Calmer than GBP/JPY, useful for trend continuation.",
  },
  {
    symbol: "AUD/JPY",
    name: "Australian Dollar / Japanese Yen",
    assetClass: "forex",
    category: "minor",
    pipSize: 0.01,
    contractSize: 100000,
    baseCurrency: "AUD",
    quoteCurrency: "JPY",
    description: "Risk-on barometer. Tracks AUD/USD plus USD/JPY composite flow.",
  },
  {
    symbol: "CAD/JPY",
    name: "Canadian Dollar / Japanese Yen",
    assetClass: "forex",
    category: "minor",
    pipSize: 0.01,
    contractSize: 100000,
    baseCurrency: "CAD",
    quoteCurrency: "JPY",
    description: "Oil-correlated yen cross. Reacts to crude moves and BoC/BoJ policy.",
  },
  {
    symbol: "NZD/JPY",
    name: "New Zealand Dollar / Japanese Yen",
    assetClass: "forex",
    category: "minor",
    pipSize: 0.01,
    contractSize: 100000,
    baseCurrency: "NZD",
    quoteCurrency: "JPY",
    description: "Carry-trade favourite. Thin liquidity outside Asia hours.",
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
    baseCurrency: "XAU",
    quoteCurrency: "USD",
    description: "Inflation hedge, safe haven. Inversely correlated with USD.",
  },
  {
    symbol: "XAG/USD",
    name: "Silver (spot)",
    assetClass: "commodity",
    category: "metal",
    pipSize: 0.001,
    contractSize: 5000,
    baseCurrency: "XAG",
    quoteCurrency: "USD",
    description: "Industrial + monetary metal. More volatile than gold.",
  },
  {
    symbol: "USOIL",
    name: "WTI Crude Oil",
    assetClass: "commodity",
    category: "energy",
    pipSize: 0.01,
    contractSize: 1000,
    baseCurrency: "USOIL",
    quoteCurrency: "USD",
    description: "US benchmark crude. Driven by inventory data and OPEC supply.",
  },
  {
    symbol: "UKOIL",
    name: "Brent Crude Oil",
    assetClass: "commodity",
    category: "energy",
    pipSize: 0.01,
    contractSize: 1000,
    baseCurrency: "UKOIL",
    quoteCurrency: "USD",
    description: "Global oil benchmark. Sensitive to geopolitical risk in EMEA.",
  },
  {
    symbol: "NATGAS",
    name: "Natural Gas",
    assetClass: "commodity",
    category: "energy",
    pipSize: 0.001,
    contractSize: 10000,
    baseCurrency: "NATGAS",
    quoteCurrency: "USD",
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
 *  - FTMO: 1:100 forex, 1:50 XAU pairs (since 2026-02-01), 1:5 stocks
 *  - Topstep (futures-only): 1:10-1:30 effective
 *  - Trading 212 retail: 1:30 forex, 1:20 indices
 * The commodity number tracks FTMO's most-recent published cap on XAU
 * (Feb 2026 update — XAUUSD Standard 1:30 → 1:50). Other commodities
 * (oil, gas, silver) typically run at 1:20-1:30; using 1:50 here is a
 * mild overestimate for non-XAU but harmless because sizing math is
 * risk-based, not leverage-based.
 */
export function defaultLeverage(assetClass: string): number {
  if (assetClass === "forex") return 100;
  if (assetClass === "commodity") return 50;
  if (assetClass === "crypto") return 5;
  return 1;
}

/**
 * Approximate USD conversion rates for non-USD currencies. Used to convert
 * cross-pair notional into account currency for backtest pnl. These are
 * starting-point heuristics — for real-time accuracy we'd swap in live FX
 * rates from Twelve Data, but for backtests these get us within ~5% of
 * the true historical rate which is good enough vs. the 100x bug we're
 * fixing.
 */
const USD_RATES: Record<string, number> = {
  USD: 1.0,
  EUR: 1.07,
  GBP: 1.27,
  JPY: 0.0067, // 1 JPY ≈ $0.0067 (USD/JPY ≈ 150)
  CHF: 1.12,
  AUD: 0.66,
  CAD: 0.74,
  NZD: 0.61,
  CNY: 0.14,
  XAU: 2400, // Approximate gold price USD/oz
  XAG: 28, // Silver
  USOIL: 75,
  UKOIL: 78,
  NATGAS: 2.5,
};

function usdRate(currency: string): number {
  return USD_RATES[currency.toUpperCase()] ?? 1;
}

/**
 * Convert a position's notional from quote-currency terms to USD. The
 * backtest engine and prop-firm rules all run in account currency (USD
 * by default), so cross-pair pnl must go through this conversion or
 * trades on EUR/JPY etc. produce 100-150x inflated pnl swings.
 *
 * For XXX/USD pairs (most majors): notional = lots × contract × price
 * (the price is USD per base, so multiplying gives USD notional).
 *
 * For USD/XXX pairs (USD/JPY, USD/CHF, USD/CAD): the BASE is USD, so
 * notional = lots × contract — the price is irrelevant for sizing.
 *
 * For cross pairs (EUR/JPY, GBP/JPY, EUR/GBP): base ≠ USD AND quote ≠
 * USD. We size off the base currency × current USD rate.
 */
export function notionalInUsd(symbol: string, lots: number, currentPrice: number): number {
  const meta = getInstrumentMeta(symbol);
  const baseUnits = lots * (meta?.contractSize ?? 1);
  const baseCcy = meta?.baseCurrency ?? "USD";
  const quoteCcy = meta?.quoteCurrency ?? "USD";

  // USD-quoted instruments (XXX/USD, XAU/USD, USOIL etc.) — price is in USD
  if (quoteCcy === "USD") return baseUnits * currentPrice;
  // USD-base pairs (USD/JPY, USD/CHF, USD/CAD) — base is USD itself
  if (baseCcy === "USD") return baseUnits;
  // Cross pairs — convert via base currency's USD rate
  return baseUnits * usdRate(baseCcy);
}

/**
 * Convert "% of capital to risk per trade" into a lot count for a specific
 * symbol, given the entry price and stop-loss percentage. Solves the math
 * that lets a single algorithm config produce equivalent % returns on any
 * account size — lots scale automatically with capital.
 *
 *   loss_when_sl_hits_USD = entry × (sl_pct / 100) × quantity × usdRate(quote)
 *   target_loss_USD       = capital × (risk_pct / 100)
 *   ⇒ quantity_in_base    = target_loss_USD / (entry × sl_pct/100 × usdRate)
 *   ⇒ lots                = quantity_in_base / contractSize
 *
 * Returns 0 when the math degenerates (zero entry / SL / contract). Caller
 * is responsible for clamping to broker volumeStep + min/max at place time.
 */
export function riskToLots(
  symbol: string,
  capital: number,
  riskPct: number,
  entryPrice: number,
  slPct: number
): number {
  if (entryPrice <= 0 || slPct <= 0 || riskPct <= 0 || capital <= 0) return 0;
  const meta = getInstrumentMeta(symbol);
  // Hard guard: an unknown forex pair would silently default quoteCurrency
  // to USD and produce ~80x oversized lots on JPY-quoted crosses (e.g.
  // CHF/JPY before it was added to the catalog). Better to refuse than to
  // place a position the user did not size for. Add the symbol to
  // FOREX_PAIRS to enable sizing.
  if (!meta && isCurrencyPair(symbol)) {
    console.error(
      `[markets] riskToLots refused: ${symbol} is not in FOREX_PAIRS catalog. ` +
        `Add an entry with the correct quoteCurrency before trading this pair.`
    );
    return 0;
  }
  const contract = meta?.contractSize ?? 1;
  const quoteCcy = meta?.quoteCurrency ?? "USD";
  const slPriceDelta = entryPrice * (slPct / 100);
  const quoteToUsd = usdRate(quoteCcy);
  const denom = slPriceDelta * quoteToUsd;
  if (denom <= 0 || contract <= 0) return 0;
  const riskUsd = capital * (riskPct / 100);
  const baseUnits = riskUsd / denom;
  return baseUnits / contract;
}

/**
 * Convert an FX/commodity unrealised or realised P&L to USD.
 *
 * The naive `(current - entry) × quantity` formula gives P&L in the QUOTE
 * currency (the currency on the right of the pair). For USD-quoted pairs
 * (AUD/USD, XAU/USD) that's already USD, but for JPY crosses (EUR/JPY, GBP/JPY)
 * it's JPY — feeding it back as if it were USD inflates the number ~150×.
 *
 * Uses the same USD rate table as `notionalInUsd`, so behaviour is consistent
 * across sizing and P&L paths.
 */
export function pnlInUsd(
  symbol: string,
  side: "long" | "short",
  entryPrice: number,
  currentPrice: number,
  quantity: number
): number {
  const meta = getInstrumentMeta(symbol);
  // Same guard as riskToLots: missing meta on a forex pair would treat the
  // quote currency as USD and inflate JPY-quoted P&L by ~150x. Log loudly
  // so the missing catalog entry gets caught instead of corrupting analytics.
  if (!meta && isCurrencyPair(symbol)) {
    console.error(
      `[markets] pnlInUsd called with unknown forex pair ${symbol}. ` +
        `Add it to FOREX_PAIRS — falling back to raw quote-currency P&L.`
    );
  }
  const quoteCcy = meta?.quoteCurrency ?? "USD";
  const direction = side === "long" ? 1 : -1;
  const quotePnl = direction * (currentPrice - entryPrice) * quantity;
  if (quoteCcy === "USD") return quotePnl;
  return quotePnl * usdRate(quoteCcy);
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
 * Default broker volume constraints used by the backtest engine. Live
 * execution always overrides these with the actual `BrokerSymbolSpec`
 * from the broker — these defaults exist so backtests produce sizes a
 * typical retail broker would accept, instead of fractional lots that
 * silently fail at fill time.
 *
 * 0.01 step / min on forex+commodity matches MetaApi MT5 + cTrader's
 * standard micro-lot resolution. maxVolume 100 is far above any
 * realistic single-position size; it's only here to prevent runaway
 * sizing bugs.
 *
 * Equity/crypto fall back to whole-unit step (1) — most paper-mode
 * configs we run today use percentage_of_capital sizing on stocks which
 * doesn't go through this clamp anyway, but the default makes the
 * fallback explicit.
 */
export interface BacktestVolumeConstraints {
  step: number;
  min: number;
  max: number;
}

export function getBacktestVolumeConstraints(
  symbol: string,
  assetClass?: string
): BacktestVolumeConstraints {
  const meta = getInstrumentMeta(symbol);
  const ac = meta?.assetClass ?? assetClass ?? "equity";
  if (ac === "forex" || ac === "commodity") {
    return { step: 0.01, min: 0.01, max: 100 };
  }
  return { step: 1, min: 1, max: Number.MAX_SAFE_INTEGER };
}

/**
 * Floor `lots` to the volume step then clamp into [min, max]. Returns 0
 * when the floored value is below min — backtest treats that as "skip
 * this entry", same as live broker rejecting an under-min order.
 */
export function clampLotsToConstraints(
  lots: number,
  constraints: BacktestVolumeConstraints
): number {
  if (lots <= 0) return 0;
  const stepped = Math.floor(lots / constraints.step) * constraints.step;
  if (stepped < constraints.min) return 0;
  return Math.min(stepped, constraints.max);
}

type StopOrTpRule =
  | { type: "percentage"; value: number }
  | { type: "fixed"; value: number }
  | { type: "pips"; value: number }
  | { type: "atr_multiple"; value: number; atr_period?: number };

/**
 * Resolve a stop-loss / take-profit rule into the absolute price distance
 * from entry (always non-negative — caller adds or subtracts based on
 * side). Centralises pip arithmetic so backtest engines, the live scan
 * engine, and the prop-firm sim all agree on what "50 pips on EUR/USD"
 * means for a given entry price.
 *
 * - percentage: entryPrice × (value / 100). Same risk-per-pair regardless
 *   of price level — but pip-equivalent stops vary across pairs.
 * - fixed:      raw value in price units. Useful for equity / crypto where
 *   you reason about dollar SL distance directly.
 * - pips:       value × pipSize from catalog. Uniform pip risk across
 *   pairs (50 pips on EUR/USD and USD/JPY both move stop by 50 pips of
 *   their respective pipSize). Falls back to 0.0001 if the symbol isn't
 *   in the catalog — caller should already be guarded against unknown
 *   forex symbols at sizing time, this is a defensive default.
 */
export function priceDeltaForRule(
  rule: StopOrTpRule,
  entryPrice: number,
  symbol: string | undefined,
  /** ATR value at entry — required when rule.type === "atr_multiple",
   *  ignored otherwise. Caller computes per-bar ATR (typically via
   *  computeAtr from regime-filter.ts) so the resulting SL/TP distance
   *  adapts to the instrument's current volatility regime. */
  atrValue?: number
): number {
  switch (rule.type) {
    case "percentage":
      return entryPrice * (rule.value / 100);
    case "fixed":
      return rule.value;
    case "pips": {
      const pipSize = getInstrumentMeta(symbol ?? "")?.pipSize ?? 0.0001;
      return rule.value * pipSize;
    }
    case "atr_multiple":
      // Defensive: when ATR is unavailable (insufficient bars), fall back
      // to a 1% conservative default. Callers should always pass atrValue
      // for atr_multiple rules; this branch exists so a missing ATR
      // doesn't produce a zero-distance SL that would never trigger.
      if (atrValue == null || atrValue <= 0) return entryPrice * 0.01;
      return rule.value * atrValue;
  }
}

/**
 * Convert any SL/TP rule into the "% of entry price" representation that
 * `riskToLots` and the older sizing paths expect. Used when sizing a
 * position before the SL price is materialised — for pip and fixed rules
 * we compute the equivalent percent at the current entry price so the
 * lot count comes out right.
 */
export function ruleAsPctOfEntry(
  rule: StopOrTpRule,
  entryPrice: number,
  symbol: string | undefined,
  atrValue?: number
): number {
  if (entryPrice <= 0) return 0;
  if (rule.type === "percentage") return rule.value;
  return (priceDeltaForRule(rule, entryPrice, symbol, atrValue) / entryPrice) * 100;
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
 * Typical broker spread in pips on FTMO MT5 demo (and similar retail MT5
 * setups) during the liquid London + London/NY overlap window. Used as
 * the bootstrap threshold for the live spread gate — refuse entries when
 * the broker's current spread exceeds `typical × multiplier`.
 *
 * Numbers below the median of Q1 2026 FTMO MT5 demo observations on
 * majors. Conservative (mid-band) so the gate doesn't reject too
 * aggressively before we have learned thresholds from real samples.
 *
 * Once we have ≥ 50 observed spreads per symbol from broker_quote_observations,
 * the gate switches to a learned per-symbol p90 and ignores this map.
 *
 * Symbols not listed return null — the gate falls back to ATR-only
 * gating for unknown instruments rather than guessing at a threshold.
 */
const TYPICAL_SPREAD_PIPS: Record<string, number> = {
  // Majors — sub-pip during peak hours, widen to 1.0-1.5 mid-session.
  "EUR/USD": 0.6,
  "GBP/USD": 0.9,
  "USD/JPY": 0.7,
  "USD/CHF": 1.5,
  "AUD/USD": 0.9,
  "USD/CAD": 1.5,
  "NZD/USD": 1.5,
  // Minors / yen crosses — wider; JPY pairs especially.
  "EUR/GBP": 1.0,
  "EUR/JPY": 1.2,
  "GBP/JPY": 1.8,
  "CHF/JPY": 2.0,
  "AUD/JPY": 1.5,
  "CAD/JPY": 2.0,
  "NZD/JPY": 2.5,
  // Metals — quoted in pips of pipSize. Gold pipSize 0.01 → 35 pips ≈ $0.35 spread.
  "XAU/USD": 35,
  "XAG/USD": 12,
  // Energies — 4-5 pips at pipSize 0.01 ≈ $0.04-0.05 spread per barrel.
  USOIL: 4,
  UKOIL: 4,
  NATGAS: 5,
};

/**
 * Typical spread (pips) for a symbol, or null when not catalogued.
 * Caller decides what "null" means — the live spread gate falls back
 * to ATR-only when no typical is known for the symbol.
 */
export function getTypicalSpreadPips(symbol: string): number | null {
  return TYPICAL_SPREAD_PIPS[symbol.toUpperCase()] ?? null;
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
