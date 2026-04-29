/**
 * Live broker spread gate — refuses entries when the broker's current
 * bid/ask gap is wider than the catalog typical for the symbol.
 *
 * Why this matters: the backtest is built on Twelve Data MID prices
 * with a fixed `spread_bps` cost layered on top. In reality FTMO MT5
 * (and most retail MT5 brokers) run variable spread that triples or
 * quadruples during 22-00 UTC, weekend opens, and immediately around
 * tier-1 economic releases. A signal that's profitable at the catalog
 * typical spread can flip to negative-EV the moment the broker quotes
 * 4-5 pips on a normally-1-pip pair.
 *
 * Bootstrap threshold = `catalog typical × 2.5` (so a normally-0.6 pip
 * EUR/USD blocks at 1.5 pips). The 2.5x multiplier was picked over a
 * more aggressive 1.5x because the catalog values are conservative
 * mid-band — too tight a multiplier rejects legitimate normal-condition
 * fills. Once we have ≥ 50 observed spreads per symbol we can swap to
 * a learned per-symbol p90 and ignore the catalog entirely.
 *
 * The gate returns full telemetry on every check (not just blocks) so
 * activity_log captures the full distribution of observed spreads —
 * giving us the data needed to tune the multiplier or switch to learned
 * thresholds without redeploying.
 */
import type { BrokerAdapter, BrokerConnection, BrokerQuote } from "@/lib/brokers/types";
import { getInstrumentMeta, getTypicalSpreadPips } from "@/lib/constants/markets";

/** Multiplier on catalog typical spread that triggers refusal.
 *  Bootstrap value — replace with learned per-symbol p90 once we have
 *  enough observed-spread samples. */
export const SPREAD_GATE_MULTIPLIER = 2.5;

export interface SpreadGateResult {
  /** True when the entry should be refused — observed spread too wide. */
  block: boolean;
  /** "skipped" when no quote was obtainable (cTrader, network error,
   *  unknown symbol). The caller should NOT block on `skipped` — the
   *  spread gate is a refinement, not a hard requirement. */
  status: "blocked" | "allowed" | "skipped";
  /** Human-readable reason, suitable for activity_log details.reason. */
  reason?: string;
  /** Telemetry fields — present whenever a quote was obtained, even
   *  when the result is `allowed`. */
  observed_spread_pips?: number;
  threshold_pips?: number;
  typical_pips?: number;
  bid?: number;
  ask?: number;
}

/**
 * Pure spread evaluation — unit-testable without a broker. Computes
 * (ask - bid) / pipSize and compares against `typicalPips × multiplier`.
 *
 * Returns `skipped` when typicalPips is null (uncatalogued symbol) so
 * the caller can fall back to non-quote gating. Returns `skipped` when
 * pipSize is invalid (≤ 0) which can happen for unknown symbols.
 */
export function evaluateSpread(
  quote: Pick<BrokerQuote, "bid" | "ask">,
  pipSize: number,
  typicalPips: number | null,
  multiplier: number = SPREAD_GATE_MULTIPLIER
): SpreadGateResult {
  if (pipSize <= 0) {
    return { block: false, status: "skipped", reason: "Unknown pip size" };
  }
  if (typicalPips == null || typicalPips <= 0) {
    return {
      block: false,
      status: "skipped",
      reason: "No catalogued typical spread",
      bid: quote.bid,
      ask: quote.ask,
    };
  }
  const observedPips = (quote.ask - quote.bid) / pipSize;
  const thresholdPips = typicalPips * multiplier;
  if (!Number.isFinite(observedPips) || observedPips < 0) {
    // Crossed or invalid quote — treat as blocked since something is wrong
    // with the feed. Better to skip the entry than fill into garbage.
    return {
      block: true,
      status: "blocked",
      reason: `Invalid quote (bid=${quote.bid}, ask=${quote.ask})`,
      observed_spread_pips: observedPips,
      threshold_pips: thresholdPips,
      typical_pips: typicalPips,
      bid: quote.bid,
      ask: quote.ask,
    };
  }
  if (observedPips > thresholdPips) {
    return {
      block: true,
      status: "blocked",
      reason: `Spread ${observedPips.toFixed(1)} pips > ${thresholdPips.toFixed(1)} threshold (typical ${typicalPips.toFixed(1)} × ${multiplier}×)`,
      observed_spread_pips: observedPips,
      threshold_pips: thresholdPips,
      typical_pips: typicalPips,
      bid: quote.bid,
      ask: quote.ask,
    };
  }
  return {
    block: false,
    status: "allowed",
    observed_spread_pips: observedPips,
    threshold_pips: thresholdPips,
    typical_pips: typicalPips,
    bid: quote.bid,
    ask: quote.ask,
  };
}

/**
 * Fetch a live quote from the broker and run the spread gate on it.
 *
 * Returns `status: "skipped"` (not blocked) when:
 *  - the adapter can't quote (cTrader streaming-only)
 *  - the network call fails
 *  - the symbol isn't in our catalog
 *
 * "skipped" is intentionally NOT a block — the live spread gate is a
 * refinement, not a hard requirement. If we can't measure spread, we
 * defer to other gates (intraday ATR, regime filter, conditions). A
 * cTrader account stays tradeable; only MetaApi/MT5 currently benefits
 * from the spread refinement.
 */
export async function checkBrokerSpread(
  adapter: BrokerAdapter,
  conn: BrokerConnection,
  appSymbol: string
): Promise<SpreadGateResult> {
  let quote: BrokerQuote | null;
  try {
    quote = await adapter.fetchQuote(conn, appSymbol);
  } catch (err) {
    return {
      block: false,
      status: "skipped",
      reason: `Quote fetch failed: ${err instanceof Error ? err.message : "unknown error"}`,
    };
  }
  if (!quote) {
    return { block: false, status: "skipped", reason: "Adapter does not expose live quotes" };
  }
  const meta = getInstrumentMeta(appSymbol);
  if (!meta) {
    return {
      block: false,
      status: "skipped",
      reason: "Symbol not in catalog",
      bid: quote.bid,
      ask: quote.ask,
    };
  }
  return evaluateSpread(quote, meta.pipSize, getTypicalSpreadPips(appSymbol));
}
